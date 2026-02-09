import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { query, initializeDatabase } from "../db/schema";

export const databaseTool = createTool({
  id: "database-tool",
  description:
    "Handles all database operations for the TWH Intelligence Platform including storing articles, entities, and summaries.",

  inputSchema: z.object({
    operation: z
      .enum([
        "init",
        "getSources",
        "checkArticleExists",
        "saveArticle",
        "saveEntities",
        "saveSummary",
        "updateArticleStatus",
        "logAction",
      ])
      .describe("The database operation to perform"),
    data: z.any().optional().describe("The data for the operation"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    result: z.any().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [databaseTool] Executing operation", {
      operation: context.operation,
    });

    try {
      switch (context.operation) {
        case "init": {
          await initializeDatabase();
          return {
            success: true,
            message: "Database initialized successfully",
          };
        }

        case "getSources": {
          const result = await query(
            "SELECT * FROM sources WHERE enabled = true ORDER BY priority DESC",
          );
          logger?.info("📊 [databaseTool] Found sources", {
            count: result.rows.length,
          });
          return { success: true, result: result.rows };
        }

        case "checkArticleExists": {
          const { contentHash, url } = context.data;
          const result = await query(
            "SELECT id FROM articles WHERE content_hash = $1 OR url = $2",
            [contentHash, url],
          );
          return {
            success: true,
            result: {
              exists: result.rows.length > 0,
              articleId: result.rows[0]?.id,
            },
          };
        }

        case "saveArticle": {
          const article = context.data;
          const result = await query(
            `INSERT INTO articles (source_id, url, title, author, published_date, raw_content, content_hash, processing_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (url) DO UPDATE SET
               title = EXCLUDED.title,
               raw_content = EXCLUDED.raw_content,
               content_hash = EXCLUDED.content_hash,
               updated_at = CURRENT_TIMESTAMP
             RETURNING id`,
            [
              article.sourceId || null,
              article.url,
              article.title,
              article.author || null,
              article.publishedDate ? new Date(article.publishedDate) : null,
              article.content,
              article.contentHash,
              "scraped",
            ],
          );
          logger?.info("💾 [databaseTool] Article saved", {
            id: result.rows[0]?.id,
          });
          return { success: true, result: { articleId: result.rows[0]?.id } };
        }

        case "saveEntities": {
          const { articleId, organizations, people, technologies } =
            context.data;

          // Save organizations and link to article
          for (const org of organizations) {
            const orgResult = await query(
              `INSERT INTO organizations (canonical_name, type)
               VALUES ($1, $2)
               ON CONFLICT (canonical_name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
               RETURNING id`,
              [org.canonicalName, org.type],
            );
            const orgId = orgResult.rows[0]?.id;

            if (orgId && articleId) {
              await query(
                `INSERT INTO article_organizations (article_id, organization_id, confidence)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (article_id, organization_id) DO NOTHING`,
                [articleId, orgId, org.confidence],
              );
            }
          }

          // Save people and link to article
          for (const person of people) {
            // First find/create the organization
            let orgId = null;
            if (person.organization) {
              const orgResult = await query(
                `SELECT id FROM organizations WHERE canonical_name = $1`,
                [person.organization],
              );
              orgId = orgResult.rows[0]?.id;
            }

            const personResult = await query(
              `INSERT INTO people (name, title, organization_id)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [person.name, person.title || null, orgId],
            );

            let personId = personResult.rows[0]?.id;
            if (!personId) {
              const existingPerson = await query(
                `SELECT id FROM people WHERE name = $1`,
                [person.name],
              );
              personId = existingPerson.rows[0]?.id;
            }

            if (personId && articleId) {
              await query(
                `INSERT INTO article_people (article_id, person_id, confidence)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (article_id, person_id) DO NOTHING`,
                [articleId, personId, person.confidence],
              );
            }
          }

          // Save technologies and link to article
          for (const tech of technologies) {
            let vendorId = null;
            if (tech.vendor) {
              const vendorResult = await query(
                `SELECT id FROM organizations WHERE canonical_name = $1`,
                [tech.vendor],
              );
              vendorId = vendorResult.rows[0]?.id;
            }

            const techResult = await query(
              `INSERT INTO technologies (name, category, vendor_id)
               VALUES ($1, $2, $3)
               ON CONFLICT (name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
               RETURNING id`,
              [tech.canonicalName, tech.category, vendorId],
            );
            const techId = techResult.rows[0]?.id;

            if (techId && articleId) {
              await query(
                `INSERT INTO article_technologies (article_id, technology_id, confidence)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (article_id, technology_id) DO NOTHING`,
                [articleId, techId, tech.confidence],
              );
            }
          }

          // Update article status
          await query(
            `UPDATE articles SET processing_status = 'extracted', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [articleId],
          );

          logger?.info("💾 [databaseTool] Entities saved", {
            orgs: organizations.length,
            people: people.length,
            tech: technologies.length,
          });
          return { success: true, message: "Entities saved successfully" };
        }

        case "saveSummary": {
          const { articleId, summary, takeaways, tags, relevanceScore } =
            context.data;

          await query(
            `INSERT INTO summaries (article_id, short_summary, key_takeaways, topic_tags, relevance_score)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (article_id) DO UPDATE SET
               short_summary = EXCLUDED.short_summary,
               key_takeaways = EXCLUDED.key_takeaways,
               topic_tags = EXCLUDED.topic_tags,
               relevance_score = EXCLUDED.relevance_score,
               updated_at = CURRENT_TIMESTAMP`,
            [articleId, summary, takeaways, tags, relevanceScore],
          );

          // Update article status
          await query(
            `UPDATE articles SET processing_status = 'summarized', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [articleId],
          );

          logger?.info("💾 [databaseTool] Summary saved", { articleId });
          return { success: true, message: "Summary saved successfully" };
        }

        case "updateArticleStatus": {
          const { articleId, status } = context.data;
          await query(
            `UPDATE articles SET processing_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [status, articleId],
          );
          return { success: true, message: "Article status updated" };
        }

        case "logAction": {
          const { agentName, action, status, details, runId } = context.data;
          await query(
            `INSERT INTO agent_logs (agent_name, action, status, details, run_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [agentName, action, status, details || {}, runId || null],
          );
          return { success: true, message: "Action logged" };
        }

        default:
          return {
            success: false,
            error: `Unknown operation: ${context.operation}`,
          };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error("❌ [databaseTool] Operation failed", {
        operation: context.operation,
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  },
});
