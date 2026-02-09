import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { buildPersonaPrompt } from "../personas";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

export const viewpointGeneratorTool = createTool({
  id: "viewpoint-generator",
  description:
    "Generates persona-specific viewpoints on healthcare IT articles using TWH host perspectives (Bill Russell, Drex DeFord, Sarah Richardson).",

  inputSchema: z.object({
    articleId: z.string().describe("The article UUID"),
    title: z.string().describe("The article title"),
    content: z.string().describe("The article content or raw text"),
    summary: z.string().describe("The existing AI-generated summary"),
    topicTags: z.array(z.string()).describe("Topic tags from the summary"),
    personaSlug: z
      .string()
      .describe("The persona slug (bill-russell, drex-deford, sarah-richardson)"),
    transcriptExcerpts: z
      .array(z.string())
      .optional()
      .describe("Relevant transcript excerpts for authenticity"),
  }),

  outputSchema: z.object({
    viewpointText: z.string(),
    keyInsights: z.array(z.string()),
    confidenceScore: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🎙️ [viewpointGenerator] Generating viewpoint", {
      personaSlug: context.personaSlug,
      title: context.title,
    });

    try {
      const systemPrompt = buildPersonaPrompt(
        context.personaSlug,
        context.transcriptExcerpts
      );

      const userPrompt = `Analyze this healthcare IT article from your unique perspective:

ARTICLE TITLE: ${context.title}

ARTICLE SUMMARY: ${context.summary}

ARTICLE CONTENT:
${(context.content || "").slice(0, 4000)}

TOPIC TAGS: ${context.topicTags.join(", ")}

Respond with valid JSON only in this exact format:
{
  "viewpoint": "Your 3-5 paragraph analysis in your authentic voice. Use first person. Reference your framework and experience.",
  "keyInsights": ["insight 1", "insight 2", "insight 3"],
  "confidenceScore": 0.85
}

The viewpoint should feel like a genuine segment from your show, not a generic AI analysis. Speak as yourself.`;

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

      logger?.info("✅ [viewpointGenerator] Viewpoint generated", {
        personaSlug: context.personaSlug,
        insightCount: result.keyInsights?.length || 0,
      });

      return {
        viewpointText: result.viewpoint,
        keyInsights: result.keyInsights || [],
        confidenceScore: result.confidenceScore || 0.8,
        success: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error("❌ [viewpointGenerator] Generation failed", {
        error: errorMessage,
        personaSlug: context.personaSlug,
      });

      return {
        viewpointText: "",
        keyInsights: [],
        confidenceScore: 0,
        success: false,
        error: errorMessage,
      };
    }
  },
});

export const roundtableGeneratorTool = createTool({
  id: "roundtable-generator",
  description:
    "Generates a Newsday-style roundtable synthesis combining all three persona viewpoints into a cohesive discussion.",

  inputSchema: z.object({
    articleId: z.string().describe("The article UUID"),
    title: z.string().describe("The article title"),
    summary: z.string().describe("The article summary"),
    billViewpoint: z.string().describe("Bill Russell's viewpoint"),
    drexViewpoint: z.string().describe("Drex DeFord's viewpoint"),
    sarahViewpoint: z.string().describe("Sarah Richardson's viewpoint"),
  }),

  outputSchema: z.object({
    viewpointText: z.string(),
    keyInsights: z.array(z.string()),
    confidenceScore: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🎙️ [roundtableGenerator] Generating Newsday roundtable", {
      title: context.title,
    });

    try {
      const systemPrompt = buildPersonaPrompt("newsday");

      const userPrompt = `Generate a Newsday roundtable discussion about this healthcare IT article.

ARTICLE TITLE: ${context.title}
ARTICLE SUMMARY: ${context.summary}

BILL RUSSELL'S PERSPECTIVE:
${context.billViewpoint}

DREX DEFORD'S PERSPECTIVE:
${context.drexViewpoint}

SARAH RICHARDSON'S PERSPECTIVE:
${context.sarahViewpoint}

Synthesize these three perspectives into a cohesive Newsday roundtable discussion.

Respond with valid JSON only in this exact format:
{
  "viewpoint": "A 4-6 paragraph flowing narrative that weaves all three perspectives together as they would naturally discuss on Newsday. Use their names naturally throughout.",
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

      logger?.info("✅ [roundtableGenerator] Roundtable generated", {
        insightCount: result.keyInsights?.length || 0,
      });

      return {
        viewpointText: result.viewpoint,
        keyInsights: result.keyInsights || [],
        confidenceScore: result.confidenceScore || 0.85,
        success: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error("❌ [roundtableGenerator] Generation failed", {
        error: errorMessage,
      });

      return {
        viewpointText: "",
        keyInsights: [],
        confidenceScore: 0,
        success: false,
        error: errorMessage,
      };
    }
  },
});
