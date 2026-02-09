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

// ======================================================================
// IMPORT AGENTS AND WORKFLOWS
// ======================================================================
import { researcherAgent } from "./agents/researcherAgent";
import { intelligenceWorkflow } from "./workflows/intelligenceWorkflow";
import { viewpointWorkflow } from "./workflows/viewpointWorkflow";
import { registerCronTrigger } from "../triggers/cronTriggers";

// ======================================================================
// REGISTER CRON TRIGGER
// ======================================================================
// The TWH Intelligence Agent runs on a schedule to monitor healthcare IT news
// Default: Every 4 hours (6 times per day)
// Can be overridden via SCHEDULE_CRON_EXPRESSION environment variable
// Intelligence workflow: scrape, extract, summarize (default every 4 hours)
registerCronTrigger({
  cronExpression: process.env.SCHEDULE_CRON_EXPRESSION || "0 */4 * * *",
  workflow: intelligenceWorkflow,
});

// Viewpoint workflow: generate persona perspectives (30 min after intelligence)
registerCronTrigger({
  cronExpression: process.env.VIEWPOINT_CRON_EXPRESSION || "30 */4 * * *",
  workflow: viewpointWorkflow,
});

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
    ],
    sourcemap: true,
  },

  server: {
    host: "0.0.0.0",
    port: 5000,
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
            const possiblePaths = [
              // Production: client folder copied to .mastra/output
              path.join(process.cwd(), "client", "index.html"),
              // Dev: Mastra runs from .mastra directory
              path.join(process.cwd(), "..", "client", "index.html"),
              // Dev fallback: workspace root
              "/home/runner/workspace/client/index.html",
              // Additional production fallbacks
              path.resolve(__dirname, "client", "index.html"),
              path.resolve(__dirname, "..", "client", "index.html"),
            ];

            for (const htmlPath of possiblePaths) {
              if (fs.existsSync(htmlPath)) {
                const html = fs.readFileSync(htmlPath, "utf-8");
                return c.html(html);
              }
            }
            return c.text(
              "Frontend not found. Tried: " + possiblePaths.join(", "),
              404,
            );
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

// Note: Multiple workflows and agents are supported in this build.
// The Replit Agent UI single-workflow/agent limitation does not apply.
