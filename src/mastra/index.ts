import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";
import { apiRoutes } from "./api/routes";
import { initializeDatabase } from "./db/operations";
import { runIntelligenceWorkflowDirect } from "./workflows/intelligenceWorkflow";
import { runViewpointWorkflowDirect } from "./workflows/viewpointWorkflow";
import { runDigestWorkflowDirect } from "./workflows/digestWorkflow";
import cron from "node-cron";

// ======================================================================
// IMPORT AGENTS AND WORKFLOWS
// ======================================================================
import { researcherAgent } from "./agents/researcherAgent";
import { intelligenceWorkflow } from "./workflows/intelligenceWorkflow";
import { viewpointWorkflow } from "./workflows/viewpointWorkflow";
import { digestWorkflow } from "./workflows/digestWorkflow";

// ======================================================================
// CUSTOM LOGGER
// ======================================================================
class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

// ======================================================================
// MASTRA INSTANCE
// ======================================================================
export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  
  // Register workflows
  workflows: {
    intelligenceWorkflow,
    viewpointWorkflow,
    digestWorkflow,
  },
  
  // Register the TWH Intelligence Researcher Agent
  agents: {
    researcherAgent,
  },
  
  bundler: {
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
      "pg",
      "rss-parser",
      "cheerio",
      "youtube-transcript",
      "ytpl",
      "node-cron",
    ],
    sourcemap: true,
  },
  
  server: {
    host: "0.0.0.0",
    port: parseInt(process.env.PORT || "4111", 10),
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      // Inngest Integration Endpoint
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
      // Dashboard API Routes
      ...apiRoutes,
      // Serve the frontend
      {
        path: "/",
        method: "GET" as const,
        handler: async (c: any) => {
          try {
            // Try multiple paths for dev and production
            // ESM-compatible __dirname alternative
            const currentDir = path.dirname(new URL(import.meta.url).pathname);
            const possiblePaths = [
              // Production: client folder copied to .mastra/output
              path.join(process.cwd(), "client", "index.html"),
              // Dev: Mastra runs from .mastra directory
              path.join(process.cwd(), "..", "client", "index.html"),
              // Dev fallback: workspace root
              "/home/runner/workspace/client/index.html",
              // Additional production fallbacks
              path.resolve(currentDir, "client", "index.html"),
              path.resolve(currentDir, "..", "client", "index.html"),
            ];
            
            for (const htmlPath of possiblePaths) {
              if (fs.existsSync(htmlPath)) {
                const html = fs.readFileSync(htmlPath, "utf-8");
                return c.html(html);
              }
            }
            return c.text("Frontend not found. Tried: " + possiblePaths.join(", "), 404);
          } catch (e) {
            return c.text("Frontend error: " + e, 500);
          }
        },
      },
    ],
  },
  
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "TWH-Intelligence",
          level: "info",
        })
      : new PinoLogger({
          name: "TWH-Intelligence",
          level: "info",
        }),
});

// Initialize database schema, seed sources/personas, and run first scrape on startup
initializeDatabase()
  .then(async () => {
    console.log("🚀 [Startup] Database initialized. Setting up scheduled workflows...");

    // Auto-trigger intelligence workflow if no articles exist yet
    try {
      const { query } = await import("./db/schema");
      const result = await query("SELECT COUNT(*) as count FROM articles");
      const articleCount = parseInt(result.rows[0]?.count || "0", 10);
      if (articleCount === 0) {
        console.log("📡 [Startup] No articles found — triggering initial intelligence workflow...");
        runIntelligenceWorkflowDirect(mastra).then(() => {
          // After initial scrape completes, run viewpoints immediately
          console.log("📡 [Startup] Running initial viewpoint generation...");
          return runViewpointWorkflowDirect(mastra);
        }).catch((err: any) => {
          console.error("❌ [Startup] Initial workflow failed:", err);
        });
      } else {
        console.log(`✅ [Startup] ${articleCount} articles already exist, skipping initial scrape`);
      }
    } catch (err) {
      console.error("❌ [Startup] Error checking articles:", err);
    }

    // ================================================================
    // CRON SCHEDULING (bypasses Inngest — runs workflows directly)
    // ================================================================
    let workflowRunning = false;

    // Intelligence workflow: scrape + process articles (default: every 4 hours)
    const intelligenceCron = process.env.SCHEDULE_CRON_EXPRESSION || "0 */4 * * *";
    cron.schedule(intelligenceCron, async () => {
      if (workflowRunning) {
        console.log("⏳ [Cron] Skipping intelligence run — previous run still active");
        return;
      }
      workflowRunning = true;
      console.log(`🕐 [Cron] Starting intelligence workflow (${new Date().toISOString()})`);
      try {
        await runIntelligenceWorkflowDirect(mastra);
        console.log("✅ [Cron] Intelligence workflow complete");
      } catch (err: any) {
        console.error("❌ [Cron] Intelligence workflow failed:", err.message);
      } finally {
        workflowRunning = false;
      }
    });
    console.log(`🕐 [Cron] Intelligence workflow scheduled: ${intelligenceCron}`);

    // Viewpoint workflow: generate persona perspectives (30 min after intelligence)
    const viewpointCron = process.env.VIEWPOINT_CRON_EXPRESSION || "30 */4 * * *";
    cron.schedule(viewpointCron, async () => {
      console.log(`🎙️ [Cron] Starting viewpoint workflow (${new Date().toISOString()})`);
      try {
        await runViewpointWorkflowDirect(mastra);
        console.log("✅ [Cron] Viewpoint workflow complete");
      } catch (err: any) {
        console.error("❌ [Cron] Viewpoint workflow failed:", err.message);
      }
    });
    console.log(`🎙️ [Cron] Viewpoint workflow scheduled: ${viewpointCron}`);

    // Digest workflow: daily email digest (default: 6 AM ET weekdays = 10:00 UTC)
    const digestCron = process.env.DIGEST_CRON_EXPRESSION || "0 10 * * 1-5";
    cron.schedule(digestCron, async () => {
      console.log(`📧 [Cron] Starting digest workflow (${new Date().toISOString()})`);
      try {
        await runDigestWorkflowDirect(mastra);
        console.log("✅ [Cron] Digest workflow complete");
      } catch (err: any) {
        console.error("❌ [Cron] Digest workflow failed:", err.message);
      }
    });
    console.log(`📧 [Cron] Digest workflow scheduled: ${digestCron}`);
  })
  .catch((err) => {
    console.error("Failed to initialize database on startup:", err);
  });
