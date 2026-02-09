import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  initializeDatabase,
  getPersonas,
  getArticlesNeedingViewpoints,
  getTranscriptsForPersona,
  saveViewpoint,
  logAction,
} from "../db/operations";
import { query } from "../db/schema";
import {
  buildPersonaPrompt,
  buildBriefPrompt,
  routeToAnalyst,
  OUTPUT_PERSONAS,
} from "../personas";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// Step 1: Find articles that need viewpoints
const findArticlesStep = createStep({
  id: "find-articles-needing-viewpoints",
  description:
    "Queries for articles that have summaries but are missing analyst viewpoints",

  inputSchema: z.object({}),

  outputSchema: z.object({
    articles: z.array(z.any()),
    personas: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🚀 [Viewpoint Step 1] Finding articles needing viewpoints...");

    try {
      await initializeDatabase();

      await logAction(
        "TWH Viewpoint Agent",
        "viewpoint_workflow_started",
        "started",
        { timestamp: new Date().toISOString() }
      );

      const personas = await getPersonas();
      const articles = await getArticlesNeedingViewpoints(20);

      logger?.info("✅ [Viewpoint Step 1] Found articles and personas", {
        articleCount: articles.length,
        personaCount: personas.length,
      });

      return { articles, personas, success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Viewpoint Step 1] Failed", { error: errorMessage });
      return { articles: [], personas: [], success: false, error: errorMessage };
    }
  },
});

// Step 2: Route each article to best analyst + generate viewpoint
const generateViewpointsStep = createStep({
  id: "generate-analyst-viewpoints",
  description:
    "Routes each article to the best-suited analyst (Bill/Drex/Sarah) and generates their viewpoint",

  inputSchema: z.object({
    articles: z.array(z.any()),
    personas: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    processedArticles: z.array(z.any()),
    viewpointsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🎙️ [Viewpoint Step 2] Generating analyst viewpoints...");

    if (!inputData.success || inputData.articles.length === 0) {
      logger?.info("ℹ️ [Viewpoint Step 2] No articles to process");
      return {
        processedArticles: [],
        viewpointsGenerated: 0,
        errors: 0,
        success: true,
      };
    }

    const personaMap = new Map(
      inputData.personas.map((p: any) => [p.slug, p])
    );

    const processedArticles: any[] = [];
    let viewpointsGenerated = 0;
    let errors = 0;

    for (const article of inputData.articles) {
      const topicTags = article.topic_tags || [];

      // Route to the best analyst based on article topics
      const analystSlug = routeToAnalyst(topicTags);
      const analyst = personaMap.get(analystSlug) as any;

      if (!analyst) {
        logger?.warn(`⚠️ [Viewpoint Step 2] Analyst not found: ${analystSlug}`);
        errors++;
        continue;
      }

      logger?.info(`📝 [Viewpoint Step 2] Routing "${article.title.slice(0, 50)}..." → ${analyst.name}`);

      try {
        // Retrieve transcript excerpts for voice authenticity
        let transcriptExcerpts: string[] = [];
        try {
          const transcripts = await getTranscriptsForPersona(
            analyst.id,
            topicTags
          );
          transcriptExcerpts = transcripts
            .slice(0, 3)
            .map((t: any) => {
              const excerpts = t.processed_excerpts || [];
              return excerpts
                .slice(0, 2)
                .map((e: any) => e.quote || e.text || "")
                .filter(Boolean)
                .join(" ");
            })
            .filter(Boolean);
        } catch {
          // Transcripts are optional enhancement
        }

        const systemPrompt = buildPersonaPrompt(analystSlug, transcriptExcerpts);

        const userPrompt = `Analyze this healthcare IT article from your unique perspective:

ARTICLE TITLE: ${article.title}

ARTICLE SUMMARY: ${article.short_summary}

ARTICLE CONTENT:
${(article.raw_content || "").slice(0, 4000)}

TOPIC TAGS: ${topicTags.join(", ")}

Respond with valid JSON only:
{
  "viewpoint": "Your 3-5 paragraph analysis in your authentic voice. Use first person. Reference your framework and experience.",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "confidenceScore": 0.85
}`;

        const response = await generateText({
          model: openai("gpt-4o-mini"),
          system: systemPrompt,
          prompt: userPrompt,
          temperature: 0.7,
        });

        const jsonMatch = response.text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("Failed to parse viewpoint response");
        }

        const result = JSON.parse(jsonMatch[0]);

        await saveViewpoint({
          articleId: article.id,
          personaId: analyst.id,
          viewpointText: result.viewpoint,
          keyInsights: result.keyInsights || [],
          confidenceScore: result.confidenceScore || 0.8,
          modelUsed: "gpt-4o-mini",
          generationMetadata: { routedTo: analystSlug, topicTags },
        });

        viewpointsGenerated++;
        processedArticles.push({
          articleId: article.id,
          title: article.title,
          analystSlug,
          analystName: analyst.name,
          viewpointText: result.viewpoint,
          summary: article.short_summary,
          topicTags,
        });

        logger?.info(`✅ [Viewpoint Step 2] ${analyst.name} viewpoint generated`, {
          articleId: article.id,
        });
      } catch (error) {
        errors++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger?.error(
          `❌ [Viewpoint Step 2] Failed for ${analystSlug}`,
          { error: errorMessage, articleId: article.id }
        );
      }
    }

    logger?.info("✅ [Viewpoint Step 2] Analyst viewpoints complete", {
      viewpointsGenerated,
      articlesProcessed: processedArticles.length,
      errors,
    });

    return { processedArticles, viewpointsGenerated, errors, success: true };
  },
});

// Step 3: Generate output persona briefs (CIO, CISO, Sales Rep, General HIT)
const generateBriefsStep = createStep({
  id: "generate-persona-briefs",
  description:
    "Generates persona-specific briefs (CIO, CISO, Sales Rep, General) from each analyst viewpoint",

  inputSchema: z.object({
    processedArticles: z.array(z.any()),
    viewpointsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    briefsGenerated: z.number(),
    totalViewpoints: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [Viewpoint Step 3] Generating output persona briefs...");

    if (inputData.processedArticles.length === 0) {
      logger?.info("ℹ️ [Viewpoint Step 3] No viewpoints to brief");
      return {
        briefsGenerated: 0,
        totalViewpoints: inputData.viewpointsGenerated,
        errors: inputData.errors,
        success: true,
      };
    }

    let briefsGenerated = 0;
    let errors = inputData.errors;
    const outputSlugs = Object.keys(OUTPUT_PERSONAS);

    for (const article of inputData.processedArticles) {
      for (const outputSlug of outputSlugs) {
        try {
          const briefPrompt = buildBriefPrompt(
            outputSlug,
            article.viewpointText,
            article.analystName,
            article.title,
            article.summary || "",
            article.topicTags || []
          );

          const response = await generateText({
            model: openai("gpt-4o-mini"),
            prompt: briefPrompt,
            temperature: 0.5,
          });

          const jsonMatch = response.text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            throw new Error("Failed to parse brief response");
          }

          const result = JSON.parse(jsonMatch[0]);

          // Store briefs in viewpoints table using a synthetic persona ID approach
          // We look up or create the output persona record
          let outputPersonaResult = await query(
            `SELECT id FROM personas WHERE slug = $1`,
            [`output-${outputSlug}`]
          );

          if (outputPersonaResult.rows.length === 0) {
            const persona = OUTPUT_PERSONAS[outputSlug];
            outputPersonaResult = await query(
              `INSERT INTO personas (slug, name, title, background, framework, system_prompt, enabled)
               VALUES ($1, $2, $3, $4, $5, $6, true)
               ON CONFLICT (slug) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
               RETURNING id`,
              [
                `output-${outputSlug}`,
                persona.name,
                persona.title,
                persona.description,
                "Output persona",
                "Brief generation template",
              ]
            );
          }

          const outputPersonaId = outputPersonaResult.rows[0]?.id;
          if (outputPersonaId) {
            await saveViewpoint({
              articleId: article.articleId,
              personaId: outputPersonaId,
              viewpointText: result.brief,
              keyInsights: [
                ...(result.keyTakeaways || []),
                ...(result.actionItems || []).map((a: string) => `ACTION: ${a}`),
              ],
              confidenceScore: 0.85,
              modelUsed: "gpt-4o-mini",
              generationMetadata: {
                type: "output-brief",
                outputPersona: outputSlug,
                headline: result.headline,
                relevanceRating: result.relevanceRating,
                analystSource: article.analystSlug,
              },
            });
            briefsGenerated++;
          }

          logger?.info(`✅ [Viewpoint Step 3] ${OUTPUT_PERSONAS[outputSlug].name} generated`, {
            articleId: article.articleId,
          });
        } catch (error) {
          errors++;
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger?.error(`❌ [Viewpoint Step 3] Brief failed for ${outputSlug}`, {
            error: errorMessage,
            articleId: article.articleId,
          });
        }
      }
    }

    logger?.info("✅ [Viewpoint Step 3] Briefs complete", {
      briefsGenerated,
      errors,
    });

    return {
      briefsGenerated,
      totalViewpoints: inputData.viewpointsGenerated + briefsGenerated,
      errors,
      success: true,
    };
  },
});

// Step 4: Log completion
const logViewpointCompletionStep = createStep({
  id: "log-viewpoint-completion",
  description: "Logs the viewpoint workflow completion and final statistics",

  inputSchema: z.object({
    briefsGenerated: z.number(),
    totalViewpoints: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    summary: z.string(),
    totalViewpoints: z.number(),
    briefsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("💾 [Viewpoint Step 4] Logging completion...");

    await logAction(
      "TWH Viewpoint Agent",
      "viewpoint_workflow_completed",
      "success",
      {
        totalViewpoints: inputData.totalViewpoints,
        briefsGenerated: inputData.briefsGenerated,
        errors: inputData.errors,
        timestamp: new Date().toISOString(),
      }
    );

    const analystCount = inputData.totalViewpoints - inputData.briefsGenerated;

    const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎙️ TWH VIEWPOINT AGENT - RUN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🗣️ Analyst Views (Bill/Drex/Sarah): ${analystCount}
📋 Output Briefs (CIO/CISO/Sales/General): ${inputData.briefsGenerated}
📊 Total Generated: ${inputData.totalViewpoints}
❌ Errors: ${inputData.errors}

Timestamp: ${new Date().toISOString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    logger?.info(summary);

    return {
      summary,
      totalViewpoints: inputData.totalViewpoints,
      briefsGenerated: inputData.briefsGenerated,
      errors: inputData.errors,
      success: true,
    };
  },
});

// Create the viewpoint workflow
export const viewpointWorkflow = createWorkflow({
  id: "twh-viewpoint-workflow",

  inputSchema: z.object({}) as any,

  outputSchema: z.object({
    summary: z.string(),
    totalViewpoints: z.number(),
    briefsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),
})
  .then(findArticlesStep as any)
  .then(generateViewpointsStep as any)
  .then(generateBriefsStep as any)
  .then(logViewpointCompletionStep as any)
  .commit();
