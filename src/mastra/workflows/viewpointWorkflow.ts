import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  initializeDatabase,
  getPersonas,
  getArticlesNeedingViewpoints,
  getArticlesNeedingRoundtable,
  getViewpointsForArticle,
  getTranscriptsForPersona,
  saveViewpoint,
  logAction,
} from "../db/operations";
import { buildPersonaPrompt, getIndividualPersonaSlugs } from "../personas";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// Step 1: Find articles that need viewpoints
const findArticlesStep = createStep({
  id: "find-articles-needing-viewpoints",
  description:
    "Queries for articles that have summaries but are missing persona viewpoints",

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

// Step 2: Generate individual persona viewpoints
const generateViewpointsStep = createStep({
  id: "generate-individual-viewpoints",
  description:
    "Generates viewpoints for each article-persona combination using AI with persona-specific prompts",

  inputSchema: z.object({
    articles: z.array(z.any()),
    personas: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    viewpointsGenerated: z.number(),
    articlesProcessed: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🎙️ [Viewpoint Step 2] Generating individual viewpoints...");

    if (!inputData.success || inputData.articles.length === 0) {
      logger?.info("ℹ️ [Viewpoint Step 2] No articles to process");
      return {
        viewpointsGenerated: 0,
        articlesProcessed: 0,
        errors: 0,
        success: true,
      };
    }

    const individualSlugs = getIndividualPersonaSlugs();
    const personaMap = new Map(
      inputData.personas
        .filter((p: any) => individualSlugs.includes(p.slug))
        .map((p: any) => [p.slug, p])
    );

    let viewpointsGenerated = 0;
    let articlesProcessed = 0;
    let errors = 0;

    for (const article of inputData.articles) {
      articlesProcessed++;
      logger?.info(`📝 [Viewpoint Step 2] Processing: ${article.title.slice(0, 60)}...`);

      for (const slug of individualSlugs) {
        const persona = personaMap.get(slug) as any;
        if (!persona) continue;

        try {
          // Retrieve relevant transcript excerpts
          let transcriptExcerpts: string[] = [];
          try {
            const transcripts = await getTranscriptsForPersona(
              persona.id,
              article.topic_tags
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

          const systemPrompt = buildPersonaPrompt(slug, transcriptExcerpts);

          const userPrompt = `Analyze this healthcare IT article from your unique perspective:

ARTICLE TITLE: ${article.title}

ARTICLE SUMMARY: ${article.short_summary}

ARTICLE CONTENT:
${(article.raw_content || "").slice(0, 4000)}

TOPIC TAGS: ${(article.topic_tags || []).join(", ")}

Respond with valid JSON only in this exact format:
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
            personaId: persona.id,
            viewpointText: result.viewpoint,
            keyInsights: result.keyInsights || [],
            confidenceScore: result.confidenceScore || 0.8,
            modelUsed: "gpt-4o-mini",
          });

          viewpointsGenerated++;
          logger?.info(`✅ [Viewpoint Step 2] Generated ${slug} viewpoint`, {
            articleId: article.id,
          });
        } catch (error) {
          errors++;
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger?.error(
            `❌ [Viewpoint Step 2] Failed for ${slug}`,
            { error: errorMessage, articleId: article.id }
          );
        }
      }
    }

    logger?.info("✅ [Viewpoint Step 2] Individual viewpoints complete", {
      viewpointsGenerated,
      articlesProcessed,
      errors,
    });

    return { viewpointsGenerated, articlesProcessed, errors, success: true };
  },
});

// Step 3: Generate Newsday roundtable synthesis
const generateRoundtableStep = createStep({
  id: "generate-newsday-roundtable",
  description:
    "Synthesizes a Newsday-style roundtable discussion using all 3 persona viewpoints",

  inputSchema: z.object({
    viewpointsGenerated: z.number(),
    articlesProcessed: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    roundtablesGenerated: z.number(),
    totalViewpoints: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🎙️ [Viewpoint Step 3] Generating Newsday roundtables...");

    if (inputData.viewpointsGenerated === 0) {
      logger?.info("ℹ️ [Viewpoint Step 3] No new viewpoints to synthesize");
      return {
        roundtablesGenerated: 0,
        totalViewpoints: inputData.viewpointsGenerated,
        errors: 0,
        success: true,
      };
    }

    const personas = await getPersonas();
    const newsdayPersona = personas.find((p: any) => p.slug === "newsday");
    if (!newsdayPersona) {
      logger?.error("❌ [Viewpoint Step 3] Newsday persona not found");
      return {
        roundtablesGenerated: 0,
        totalViewpoints: inputData.viewpointsGenerated,
        errors: 1,
        success: false,
      };
    }

    const articlesNeedingRoundtable = await getArticlesNeedingRoundtable();
    let roundtablesGenerated = 0;
    let errors = 0;

    for (const article of articlesNeedingRoundtable) {
      try {
        const viewpoints = await getViewpointsForArticle(article.id);

        const billVp = viewpoints.find(
          (v: any) => v.persona_slug === "bill-russell"
        );
        const drexVp = viewpoints.find(
          (v: any) => v.persona_slug === "drex-deford"
        );
        const sarahVp = viewpoints.find(
          (v: any) => v.persona_slug === "sarah-richardson"
        );

        if (!billVp || !drexVp || !sarahVp) continue;

        const systemPrompt = buildPersonaPrompt("newsday");

        const userPrompt = `Generate a Newsday roundtable discussion about this healthcare IT article.

ARTICLE TITLE: ${article.title}

BILL RUSSELL'S PERSPECTIVE:
${billVp.viewpoint_text}

DREX DEFORD'S PERSPECTIVE:
${drexVp.viewpoint_text}

SARAH RICHARDSON'S PERSPECTIVE:
${sarahVp.viewpoint_text}

Respond with valid JSON only:
{
  "viewpoint": "A 4-6 paragraph flowing narrative that weaves all three perspectives together as they would naturally discuss on Newsday.",
  "keyInsights": ["combined insight 1", "combined insight 2", "combined insight 3"],
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
          throw new Error("Failed to parse roundtable response");
        }

        const result = JSON.parse(jsonMatch[0]);

        await saveViewpoint({
          articleId: article.id,
          personaId: newsdayPersona.id,
          viewpointText: result.viewpoint,
          keyInsights: result.keyInsights || [],
          confidenceScore: result.confidenceScore || 0.85,
          modelUsed: "gpt-4o-mini",
        });

        roundtablesGenerated++;
        logger?.info("✅ [Viewpoint Step 3] Roundtable generated", {
          articleId: article.id,
        });
      } catch (error) {
        errors++;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger?.error("❌ [Viewpoint Step 3] Roundtable failed", {
          error: errorMessage,
          articleId: article.id,
        });
      }
    }

    logger?.info("✅ [Viewpoint Step 3] Roundtable generation complete", {
      roundtablesGenerated,
      errors,
    });

    return {
      roundtablesGenerated,
      totalViewpoints: inputData.viewpointsGenerated + roundtablesGenerated,
      errors: inputData.errors + errors,
      success: true,
    };
  },
});

// Step 4: Log completion
const logViewpointCompletionStep = createStep({
  id: "log-viewpoint-completion",
  description: "Logs the viewpoint workflow completion and final statistics",

  inputSchema: z.object({
    roundtablesGenerated: z.number(),
    totalViewpoints: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    summary: z.string(),
    totalViewpoints: z.number(),
    roundtablesGenerated: z.number(),
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
        roundtablesGenerated: inputData.roundtablesGenerated,
        errors: inputData.errors,
        timestamp: new Date().toISOString(),
      }
    );

    const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎙️ TWH VIEWPOINT AGENT - RUN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🗣️ Individual Viewpoints: ${inputData.totalViewpoints - inputData.roundtablesGenerated}
📺 Newsday Roundtables: ${inputData.roundtablesGenerated}
📊 Total Viewpoints: ${inputData.totalViewpoints}
❌ Errors: ${inputData.errors}

Timestamp: ${new Date().toISOString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    logger?.info(summary);

    return {
      summary,
      totalViewpoints: inputData.totalViewpoints,
      roundtablesGenerated: inputData.roundtablesGenerated,
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
    roundtablesGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),
})
  .then(findArticlesStep as any)
  .then(generateViewpointsStep as any)
  .then(generateRoundtableStep as any)
  .then(logViewpointCompletionStep as any)
  .commit();
