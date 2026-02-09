import { query } from "../db/schema";
import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { saveArticle, saveEntities, saveSummary, saveViewpoint } from "../db/operations";
import { buildPersonaPrompt, getIndividualPersonaSlugs } from "../personas";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD" | "ALL";

const SOURCE_FILES = [
  { name: "intelligenceWorkflow.ts", path: "src/mastra/workflows/intelligenceWorkflow.ts", description: "Main workflow with 5-step process" },
  { name: "viewpointWorkflow.ts", path: "src/mastra/workflows/viewpointWorkflow.ts", description: "Persona viewpoint generation workflow" },
  { name: "researcherAgent.ts", path: "src/mastra/agents/researcherAgent.ts", description: "AI agent with healthcare IT expertise" },
  { name: "webScraperTool.ts", path: "src/mastra/tools/webScraperTool.ts", description: "RSS and HTML scraping logic" },
  { name: "entityExtractorTool.ts", path: "src/mastra/tools/entityExtractorTool.ts", description: "AI-powered entity extraction" },
  { name: "entityNormalizerTool.ts", path: "src/mastra/tools/entityNormalizerTool.ts", description: "Canonical name normalization" },
  { name: "viewpointGeneratorTool.ts", path: "src/mastra/tools/viewpointGeneratorTool.ts", description: "Persona viewpoint generation" },
  { name: "transcriptIngestionTool.ts", path: "src/mastra/tools/transcriptIngestionTool.ts", description: "YouTube transcript fetching" },
  { name: "databaseTool.ts", path: "src/mastra/tools/databaseTool.ts", description: "Database operations tool" },
  { name: "prompts.ts", path: "src/mastra/personas/prompts.ts", description: "TWH persona system prompts" },
  { name: "schema.ts", path: "src/mastra/db/schema.ts", description: "Database table definitions" },
  { name: "operations.ts", path: "src/mastra/db/operations.ts", description: "Database query functions" },
  { name: "index.ts", path: "src/mastra/index.ts", description: "Mastra instance and cron trigger" },
];

export const apiRoutes: Array<{
  path: string;
  method: HttpMethod;
  handler: (c: any) => Promise<any>;
}> = [
  {
    path: "/api/dashboard",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("📊 [API] Fetching dashboard stats");

      const stats = await query(`
        SELECT
          (SELECT COUNT(*) FROM articles) as total_articles,
          (SELECT COUNT(*) FROM organizations) as total_organizations,
          (SELECT COUNT(*) FROM people) as total_people,
          (SELECT COUNT(*) FROM technologies) as total_technologies,
          (SELECT COUNT(*) FROM summaries) as total_summaries,
          (SELECT COUNT(*) FROM sources WHERE enabled = true) as active_sources,
          (SELECT COUNT(*) FROM viewpoints) as total_viewpoints,
          (SELECT COUNT(*) FROM personas WHERE enabled = true) as active_personas,
          (SELECT COUNT(*) FROM transcripts) as total_transcripts
      `);

      const recentArticles = await query(`
        SELECT 
          a.id, a.title, a.url, a.published_date, a.created_at,
          s.short_summary, s.topic_tags, s.relevance_score,
          src.name as source_name
        FROM articles a
        LEFT JOIN summaries s ON a.id = s.article_id
        LEFT JOIN sources src ON a.source_id = src.id
        ORDER BY a.created_at DESC
        LIMIT 20
      `);

      return c.json({
        stats: stats.rows[0],
        recentArticles: recentArticles.rows,
      });
    },
  },
  {
    path: "/api/articles",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("📰 [API] Fetching articles");

      const articles = await query(`
        SELECT 
          a.id, a.title, a.url, a.author, a.published_date, a.created_at,
          s.short_summary, s.topic_tags, s.relevance_score,
          src.name as source_name,
          array_agg(DISTINCT o.canonical_name) FILTER (WHERE o.canonical_name IS NOT NULL) as organizations,
          array_agg(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL) as technologies,
          array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL) as people
        FROM articles a
        LEFT JOIN summaries s ON a.id = s.article_id
        LEFT JOIN sources src ON a.source_id = src.id
        LEFT JOIN article_organizations ao ON a.id = ao.article_id
        LEFT JOIN organizations o ON ao.organization_id = o.id
        LEFT JOIN article_technologies at ON a.id = at.article_id
        LEFT JOIN technologies t ON at.technology_id = t.id
        LEFT JOIN article_people ap ON a.id = ap.article_id
        LEFT JOIN people p ON ap.person_id = p.id
        GROUP BY a.id, s.short_summary, s.topic_tags, s.relevance_score, src.name
        ORDER BY a.created_at DESC
        LIMIT 100
      `);

      return c.json({ articles: articles.rows });
    },
  },
  {
    path: "/api/articles/:id",
    method: "GET",
    handler: async (c: any) => {
      const id = c.req.param("id");

      const article = await query(
        `
        SELECT 
          a.*,
          s.short_summary, s.key_takeaways, s.topic_tags, s.relevance_score,
          src.name as source_name, src.url as source_url
        FROM articles a
        LEFT JOIN summaries s ON a.id = s.article_id
        LEFT JOIN sources src ON a.source_id = src.id
        WHERE a.id = $1
      `,
        [id]
      );

      if (article.rows.length === 0) {
        return c.json({ error: "Article not found" }, 404);
      }

      const organizations = await query(
        `
        SELECT o.canonical_name, o.type, ao.confidence
        FROM organizations o
        JOIN article_organizations ao ON o.id = ao.organization_id
        WHERE ao.article_id = $1
      `,
        [id]
      );

      const technologies = await query(
        `
        SELECT t.name, t.category, at.confidence
        FROM technologies t
        JOIN article_technologies at ON t.id = at.technology_id
        WHERE at.article_id = $1
      `,
        [id]
      );

      const people = await query(
        `
        SELECT p.name, p.title, ap.confidence, o.canonical_name as organization
        FROM people p
        JOIN article_people ap ON p.id = ap.person_id
        LEFT JOIN organizations o ON p.organization_id = o.id
        WHERE ap.article_id = $1
      `,
        [id]
      );

      const viewpoints = await query(
        `
        SELECT v.*, p.name as persona_name, p.slug as persona_slug, p.title as persona_title, p.framework as persona_framework
        FROM viewpoints v
        JOIN personas p ON v.persona_id = p.id
        WHERE v.article_id = $1
        ORDER BY p.slug
      `,
        [id]
      );

      return c.json({
        article: article.rows[0],
        organizations: organizations.rows,
        technologies: technologies.rows,
        people: people.rows,
        viewpoints: viewpoints.rows,
      });
    },
  },
  {
    path: "/api/sources",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("📡 [API] Fetching sources");

      const sources = await query(`
        SELECT 
          s.*,
          (SELECT COUNT(*) FROM articles WHERE source_id = s.id) as article_count
        FROM sources s
        ORDER BY s.priority DESC, s.name ASC
      `);

      return c.json({ sources: sources.rows });
    },
  },
  {
    path: "/api/sources",
    method: "POST",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const body = await c.req.json();

      logger?.info("➕ [API] Adding new source", { name: body.name });

      const result = await query(
        `INSERT INTO sources (name, url, source_type, selector, enabled, priority)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          body.name,
          body.url,
          body.sourceType || "rss",
          body.selector || null,
          body.enabled !== false,
          body.priority || 5,
        ]
      );

      return c.json({ source: result.rows[0] });
    },
  },
  {
    path: "/api/sources/:id",
    method: "PUT",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const id = c.req.param("id");
      const body = await c.req.json();
      logger?.info("✏️ [API] Updating source", { id });

      const result = await query(
        `UPDATE sources 
         SET name = COALESCE($1, name),
             url = COALESCE($2, url),
             source_type = COALESCE($3, source_type),
             selector = $4,
             enabled = COALESCE($5, enabled),
             priority = COALESCE($6, priority),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $7
         RETURNING *`,
        [
          body.name,
          body.url,
          body.sourceType,
          body.selector,
          body.enabled,
          body.priority,
          id,
        ]
      );

      return c.json({ source: result.rows[0] });
    },
  },
  {
    path: "/api/sources/:id",
    method: "DELETE",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const id = c.req.param("id");
      logger?.info("🗑️ [API] Deleting source", { id });
      
      await query(`DELETE FROM sources WHERE id = $1`, [id]);
      return c.json({ success: true });
    },
  },
  {
    path: "/api/entities/organizations",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("🏢 [API] Fetching organizations");

      const orgs = await query(`
        SELECT 
          o.*,
          (SELECT COUNT(*) FROM article_organizations WHERE organization_id = o.id) as article_count
        FROM organizations o
        ORDER BY article_count DESC, o.canonical_name ASC
        LIMIT 100
      `);

      return c.json({ organizations: orgs.rows });
    },
  },
  {
    path: "/api/entities/technologies",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("💻 [API] Fetching technologies");

      const tech = await query(`
        SELECT 
          t.*,
          o.canonical_name as vendor_name,
          (SELECT COUNT(*) FROM article_technologies WHERE technology_id = t.id) as article_count
        FROM technologies t
        LEFT JOIN organizations o ON t.vendor_id = o.id
        ORDER BY article_count DESC, t.name ASC
        LIMIT 100
      `);

      return c.json({ technologies: tech.rows });
    },
  },
  {
    path: "/api/entities/people",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("👤 [API] Fetching people");

      const people = await query(`
        SELECT 
          p.*,
          o.canonical_name as organization_name,
          (SELECT COUNT(*) FROM article_people WHERE person_id = p.id) as article_count
        FROM people p
        LEFT JOIN organizations o ON p.organization_id = o.id
        ORDER BY article_count DESC, p.name ASC
        LIMIT 100
      `);

      return c.json({ people: people.rows });
    },
  },
  {
    path: "/api/logs",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("📋 [API] Fetching agent logs");

      const logs = await query(`
        SELECT * FROM agent_logs
        ORDER BY created_at DESC
        LIMIT 50
      `);

      return c.json({ logs: logs.rows });
    },
  },
  {
    path: "/api/trigger",
    method: "POST",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("🚀 [API] Manual trigger requested");

      try {
        // Use the Mastra workflow API to start the workflow
        const workflow = mastra?.getWorkflow("intelligenceWorkflow");
        if (workflow) {
          const result = await workflow.start({ inputData: {} });
          logger?.info("✅ [API] Workflow started", { runId: result?.runId });
          return c.json({ success: true, message: "Workflow triggered", runId: result?.runId });
        } else {
          logger?.error("❌ [API] Workflow not found");
          return c.json({ success: false, message: "Workflow not found" }, 404);
        }
      } catch (error: any) {
        logger?.error("❌ [API] Trigger failed", { error: error.message });
        return c.json({ success: false, message: error.message }, 500);
      }
    },
  },
  // ======================================================================
  // MANUAL ARTICLE SUBMISSION
  // ======================================================================
  {
    path: "/api/articles/submit",
    method: "POST" as const,
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const body = await c.req.json();

      logger?.info("📝 [API] Manual article submission", { title: body.title, url: body.url });

      // Validate required fields
      if (!body.title || (!body.content && !body.url)) {
        return c.json({ error: "Required: title + either content or url" }, 400);
      }

      try {
        const openai = createOpenAI({
          baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
          apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        });

        // If URL provided but no content, try to scrape it
        let content = body.content || "";
        if (body.url && !content) {
          try {
            const cheerio = await import("cheerio");
            const response = await fetch(body.url, {
              headers: { "User-Agent": "TWH-Intelligence-Agent/1.0" },
            });
            if (response.ok) {
              const html = await response.text();
              const $ = cheerio.load(html);
              $("script, style, nav, footer, header, aside").remove();
              content = $("article, main, .content, .post-body, .entry-content, body")
                .first()
                .text()
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 10000);
            }
          } catch (scrapeErr) {
            logger?.warn("⚠️ [API] Could not scrape URL, using provided content", {
              error: String(scrapeErr),
            });
          }
        }

        if (!content || content.length < 20) {
          return c.json({ error: "No content available. Provide content directly or a scrapeable URL." }, 400);
        }

        const contentHash = crypto.createHash("md5").update(content).digest("hex");

        // 1. Save the article
        const articleId = await saveArticle({
          url: body.url || `manual://${Date.now()}`,
          title: body.title,
          author: body.author || "Manual submission",
          publishedDate: body.publishedDate || new Date().toISOString(),
          content,
          contentHash,
        });

        logger?.info("💾 [API] Article saved", { articleId });

        // 2. Extract entities
        let entitiesExtracted = 0;
        try {
          const extractResponse = await generateText({
            model: openai("gpt-4o-mini"),
            prompt: `Extract entities from this healthcare IT article.

ARTICLE TITLE: ${body.title}

ARTICLE CONTENT:
${content.slice(0, 4000)}

Extract:
1. Organizations (health_system, vendor, payer, startup, agency, other)
2. People (with titles and org affiliations)
3. Technologies (EHR, cybersecurity, AI, interoperability, analytics, telehealth, cloud, other)

Respond with JSON only:
{
  "organizations": [{"name": "...", "type": "vendor", "confidence": 0.9}],
  "people": [{"name": "...", "title": "...", "organization": "...", "confidence": 0.9}],
  "technologies": [{"name": "...", "category": "EHR", "vendor": "...", "confidence": 0.9}]
}`,
            temperature: 0.2,
          });

          const jsonMatch = extractResponse.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const extracted = JSON.parse(jsonMatch[0]);
            const orgs = (extracted.organizations || []).map((o: any) => ({
              canonicalName: o.name,
              type: o.type,
              confidence: o.confidence,
            }));
            const people = (extracted.people || []).map((p: any) => ({
              name: p.name,
              title: p.title,
              organization: p.organization,
              confidence: p.confidence,
            }));
            const tech = (extracted.technologies || []).map((t: any) => ({
              canonicalName: t.name,
              category: t.category,
              vendor: t.vendor,
              confidence: t.confidence,
            }));
            await saveEntities(articleId, orgs, people, tech);
            entitiesExtracted = orgs.length + people.length + tech.length;
          }
        } catch (e) {
          logger?.warn("⚠️ [API] Entity extraction failed", { error: String(e) });
        }

        // 3. Generate summary
        let summaryData: any = null;
        try {
          const summaryResponse = await generateText({
            model: openai("gpt-4o-mini"),
            prompt: `Analyze this healthcare IT article:

TITLE: ${body.title}
CONTENT: ${content.slice(0, 3000)}

Respond in JSON:
{
  "summary": "2-3 sentence summary",
  "takeaways": ["takeaway 1", "takeaway 2", "takeaway 3"],
  "tags": ["cybersecurity", "AI"],
  "relevanceScore": 8
}`,
            temperature: 0.3,
          });

          const jsonMatch = summaryResponse.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            summaryData = JSON.parse(jsonMatch[0]);
            await saveSummary(
              articleId,
              summaryData.summary,
              summaryData.takeaways || [],
              summaryData.tags || [],
              summaryData.relevanceScore || 5
            );
          }
        } catch (e) {
          logger?.warn("⚠️ [API] Summary generation failed", { error: String(e) });
        }

        // 4. Generate persona viewpoints (if relevance >= 6)
        let viewpointsGenerated = 0;
        if (summaryData && (summaryData.relevanceScore || 0) >= 6) {
          const personas = await query(
            `SELECT * FROM personas WHERE enabled = true AND slug != 'newsday' ORDER BY slug`
          );

          for (const persona of personas.rows) {
            try {
              const systemPrompt = buildPersonaPrompt(persona.slug);
              const vpResponse = await generateText({
                model: openai("gpt-4o-mini"),
                system: systemPrompt,
                prompt: `Analyze this healthcare IT article from your unique perspective:

ARTICLE TITLE: ${body.title}
ARTICLE SUMMARY: ${summaryData.summary}
ARTICLE CONTENT: ${content.slice(0, 4000)}
TOPIC TAGS: ${(summaryData.tags || []).join(", ")}

Respond with valid JSON only:
{
  "viewpoint": "Your 3-5 paragraph analysis in your authentic voice.",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "confidenceScore": 0.85
}`,
                temperature: 0.7,
              });

              const vpMatch = vpResponse.text.match(/\{[\s\S]*\}/);
              if (vpMatch) {
                const vp = JSON.parse(vpMatch[0]);
                await saveViewpoint({
                  articleId,
                  personaId: persona.id,
                  viewpointText: vp.viewpoint,
                  keyInsights: vp.keyInsights || [],
                  confidenceScore: vp.confidenceScore || 0.8,
                  modelUsed: "gpt-4o-mini",
                });
                viewpointsGenerated++;
              }
            } catch (e) {
              logger?.warn(`⚠️ [API] Viewpoint generation failed for ${persona.slug}`, {
                error: String(e),
              });
            }
          }

          // Generate Newsday roundtable if all 3 viewpoints exist
          if (viewpointsGenerated === 3) {
            try {
              const viewpoints = await query(
                `SELECT v.*, p.slug as persona_slug FROM viewpoints v
                 JOIN personas p ON v.persona_id = p.id
                 WHERE v.article_id = $1 AND p.slug != 'newsday'`,
                [articleId]
              );

              const billVp = viewpoints.rows.find((v: any) => v.persona_slug === "bill-russell");
              const drexVp = viewpoints.rows.find((v: any) => v.persona_slug === "drex-deford");
              const sarahVp = viewpoints.rows.find((v: any) => v.persona_slug === "sarah-richardson");

              if (billVp && drexVp && sarahVp) {
                const newsdayPersona = await query(
                  `SELECT * FROM personas WHERE slug = 'newsday'`
                );

                if (newsdayPersona.rows[0]) {
                  const rtResponse = await generateText({
                    model: openai("gpt-4o-mini"),
                    system: buildPersonaPrompt("newsday"),
                    prompt: `Generate a Newsday roundtable discussion about this article.

ARTICLE TITLE: ${body.title}
ARTICLE SUMMARY: ${summaryData.summary}

BILL RUSSELL'S PERSPECTIVE: ${billVp.viewpoint_text}
DREX DEFORD'S PERSPECTIVE: ${drexVp.viewpoint_text}
SARAH RICHARDSON'S PERSPECTIVE: ${sarahVp.viewpoint_text}

Respond with valid JSON:
{
  "viewpoint": "4-6 paragraph narrative weaving all three perspectives.",
  "keyInsights": ["combined insight 1", "combined insight 2", "combined insight 3"],
  "confidenceScore": 0.85
}`,
                    temperature: 0.7,
                  });

                  const rtMatch = rtResponse.text.match(/\{[\s\S]*\}/);
                  if (rtMatch) {
                    const rt = JSON.parse(rtMatch[0]);
                    await saveViewpoint({
                      articleId,
                      personaId: newsdayPersona.rows[0].id,
                      viewpointText: rt.viewpoint,
                      keyInsights: rt.keyInsights || [],
                      confidenceScore: rt.confidenceScore || 0.85,
                      modelUsed: "gpt-4o-mini",
                    });
                    viewpointsGenerated++;
                  }
                }
              }
            } catch (e) {
              logger?.warn("⚠️ [API] Newsday roundtable failed", { error: String(e) });
            }
          }
        }

        logger?.info("✅ [API] Manual article fully processed", {
          articleId,
          entitiesExtracted,
          hasSummary: !!summaryData,
          viewpointsGenerated,
        });

        return c.json({
          success: true,
          articleId,
          title: body.title,
          entitiesExtracted,
          summary: summaryData?.summary || null,
          relevanceScore: summaryData?.relevanceScore || null,
          tags: summaryData?.tags || [],
          viewpointsGenerated,
          message: viewpointsGenerated > 0
            ? `Article processed with ${viewpointsGenerated} persona viewpoints`
            : "Article processed (viewpoints skipped - relevance below 6)",
        });
      } catch (error: any) {
        logger?.error("❌ [API] Manual submission failed", { error: error.message });
        return c.json({ success: false, error: error.message }, 500);
      }
    },
  },
  // ======================================================================
  // PERSONA & VIEWPOINT ENDPOINTS
  // ======================================================================
  {
    path: "/api/personas",
    method: "GET" as const,
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("🎙️ [API] Fetching personas");

      const personas = await query(`
        SELECT
          p.*,
          (SELECT COUNT(*) FROM viewpoints WHERE persona_id = p.id) as viewpoint_count,
          (SELECT COUNT(*) FROM transcripts WHERE persona_id = p.id) as transcript_count
        FROM personas p
        ORDER BY p.slug
      `);

      return c.json({ personas: personas.rows });
    },
  },
  {
    path: "/api/viewpoints/:articleId",
    method: "GET" as const,
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const articleId = c.req.param("articleId");
      logger?.info("🗣️ [API] Fetching viewpoints for article", { articleId });

      const viewpoints = await query(
        `SELECT v.*, p.name as persona_name, p.slug as persona_slug,
                p.title as persona_title, p.framework as persona_framework
         FROM viewpoints v
         JOIN personas p ON v.persona_id = p.id
         WHERE v.article_id = $1
         ORDER BY p.slug`,
        [articleId]
      );

      const article = await query(
        `SELECT a.title, a.url, s.short_summary, s.topic_tags, s.relevance_score
         FROM articles a
         LEFT JOIN summaries s ON a.id = s.article_id
         WHERE a.id = $1`,
        [articleId]
      );

      return c.json({
        article: article.rows[0] || null,
        viewpoints: viewpoints.rows,
      });
    },
  },
  {
    path: "/api/viewpoints/:articleId/:personaSlug",
    method: "GET" as const,
    handler: async (c: any) => {
      const articleId = c.req.param("articleId");
      const personaSlug = c.req.param("personaSlug");

      const viewpoint = await query(
        `SELECT v.*, p.name as persona_name, p.slug as persona_slug,
                p.title as persona_title, p.framework as persona_framework
         FROM viewpoints v
         JOIN personas p ON v.persona_id = p.id
         WHERE v.article_id = $1 AND p.slug = $2`,
        [articleId, personaSlug]
      );

      if (viewpoint.rows.length === 0) {
        return c.json({ error: "Viewpoint not found" }, 404);
      }

      return c.json({ viewpoint: viewpoint.rows[0] });
    },
  },
  {
    path: "/api/viewpoints/generate",
    method: "POST" as const,
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("🚀 [API] Manual viewpoint generation requested");

      try {
        const workflow = mastra?.getWorkflow("viewpointWorkflow");
        if (workflow) {
          const result = await workflow.start({ inputData: {} });
          logger?.info("✅ [API] Viewpoint workflow started", { runId: result?.runId });
          return c.json({ success: true, message: "Viewpoint workflow triggered", runId: result?.runId });
        } else {
          return c.json({ success: false, message: "Viewpoint workflow not found" }, 404);
        }
      } catch (error: any) {
        logger?.error("❌ [API] Viewpoint trigger failed", { error: error.message });
        return c.json({ success: false, message: error.message }, 500);
      }
    },
  },
  {
    path: "/api/transcripts/ingest",
    method: "POST" as const,
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const body = await c.req.json();
      logger?.info("📺 [API] Transcript ingestion requested", { personaSlug: body.personaSlug });

      try {
        const persona = await query(
          `SELECT * FROM personas WHERE slug = $1`,
          [body.personaSlug]
        );

        if (persona.rows.length === 0) {
          return c.json({ error: "Persona not found" }, 404);
        }

        return c.json({
          success: true,
          message: `Transcript ingestion queued for ${body.personaSlug}`,
          persona: persona.rows[0],
        });
      } catch (error: any) {
        logger?.error("❌ [API] Transcript ingestion failed", { error: error.message });
        return c.json({ success: false, message: error.message }, 500);
      }
    },
  },
  {
    path: "/api/transcripts/:personaSlug",
    method: "GET" as const,
    handler: async (c: any) => {
      const personaSlug = c.req.param("personaSlug");

      const transcripts = await query(
        `SELECT t.id, t.video_id, t.video_title, t.video_url, t.published_date,
                t.topic_tags, t.duration_seconds, t.processing_status, t.created_at,
                LENGTH(t.raw_transcript) as transcript_length
         FROM transcripts t
         JOIN personas p ON t.persona_id = p.id
         WHERE p.slug = $1
         ORDER BY t.created_at DESC
         LIMIT 50`,
        [personaSlug]
      );

      return c.json({ transcripts: transcripts.rows });
    },
  },
  // ======================================================================
  // SOURCE FILE ENDPOINTS
  // ======================================================================
  {
    path: "/api/source-files",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      logger?.info("📁 [API] Fetching source files list");

      return c.json({ files: SOURCE_FILES });
    },
  },
  {
    path: "/api/source-files/:filename",
    method: "GET",
    handler: async (c: any) => {
      const mastra = c.get("mastra");
      const logger = mastra?.getLogger();
      const filename = c.req.param("filename");

      logger?.info("📥 [API] Download source file", { filename });

      const file = SOURCE_FILES.find(f => f.name === filename);
      if (!file) {
        return c.json({ error: "File not found" }, 404);
      }

      try {
        // Try multiple paths - development and production may have different working directories
        const possiblePaths = [
          path.join(process.cwd(), file.path),
          path.join(process.cwd(), "..", file.path),
          path.join("/home/runner/workspace", file.path),
        ];

        let content = "";
        for (const filePath of possiblePaths) {
          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, "utf-8");
            break;
          }
        }

        if (!content) {
          return c.json({ error: "File not found on disk" }, 404);
        }

        return new Response(content, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      } catch (error: any) {
        logger?.error("❌ [API] Failed to read file", { error: error.message });
        return c.json({ error: "Failed to read file" }, 500);
      }
    },
  },
];
