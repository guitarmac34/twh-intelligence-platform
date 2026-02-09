import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

export const entityExtractorTool = createTool({
  id: "entity-extractor",
  description:
    "Extracts structured entities (organizations, people, technologies) from article content using AI. Specialized for healthcare IT domain.",

  inputSchema: z.object({
    title: z.string().describe("The article title"),
    content: z.string().describe("The article content to extract entities from"),
    articleUrl: z.string().describe("The article URL for reference"),
  }),

  outputSchema: z.object({
    organizations: z.array(
      z.object({
        name: z.string(),
        type: z.enum(["health_system", "vendor", "payer", "startup", "agency", "other"]),
        confidence: z.number(),
      })
    ),
    people: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        organization: z.string().optional(),
        confidence: z.number(),
      })
    ),
    technologies: z.array(
      z.object({
        name: z.string(),
        category: z.enum(["EHR", "cybersecurity", "AI", "interoperability", "analytics", "telehealth", "cloud", "other"]),
        vendor: z.string().optional(),
        confidence: z.number(),
      })
    ),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [entityExtractorTool] Extracting entities", {
      title: context.title,
      contentLength: context.content.length,
    });

    try {
      const prompt = `You are a healthcare IT industry expert. Extract all mentioned entities from this article.

ARTICLE TITLE: ${context.title}

ARTICLE CONTENT:
${context.content.slice(0, 4000)}

Extract the following entity types:

1. ORGANIZATIONS:
   - Health systems (hospitals, health networks, integrated delivery networks)
   - Vendors (Epic, Oracle Health, Microsoft, etc.)
   - Payers (insurance companies, CMS, etc.)
   - Startups (healthcare tech startups)
   - Agencies (government agencies like HHS, ONC, etc.)

2. PEOPLE:
   - Executives (CIO, CMIO, CNIO, CEO, CFO, etc.)
   - Authors and quoted individuals
   - Include their title/role and organization when mentioned

3. TECHNOLOGIES:
   - Products and platforms (Epic Cosmos, Azure, etc.)
   - Standards (FHIR, HL7, etc.)
   - Categories: EHR, cybersecurity, AI, interoperability, analytics, telehealth, cloud

For each entity, provide a confidence score (0.0 to 1.0) based on how clearly it's mentioned.

Respond with valid JSON only in this exact format:
{
  "organizations": [{"name": "...", "type": "health_system|vendor|payer|startup|agency|other", "confidence": 0.9}],
  "people": [{"name": "...", "title": "...", "organization": "...", "confidence": 0.9}],
  "technologies": [{"name": "...", "category": "EHR|cybersecurity|AI|interoperability|analytics|telehealth|cloud|other", "vendor": "...", "confidence": 0.9}]
}`;

      const response = await generateText({
        model: openai("gpt-4o-mini"),
        prompt,
        temperature: 0.2,
      });

      // Parse the JSON response
      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Failed to parse entity extraction response");
      }

      const extracted = JSON.parse(jsonMatch[0]);

      logger?.info("✅ [entityExtractorTool] Extraction complete", {
        orgs: extracted.organizations?.length || 0,
        people: extracted.people?.length || 0,
        tech: extracted.technologies?.length || 0,
      });

      return {
        organizations: extracted.organizations || [],
        people: extracted.people || [],
        technologies: extracted.technologies || [],
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [entityExtractorTool] Extraction failed", { error: errorMessage });

      return {
        organizations: [],
        people: [],
        technologies: [],
        success: false,
        error: errorMessage,
      };
    }
  },
});
