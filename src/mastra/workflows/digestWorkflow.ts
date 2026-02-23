import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import {
  initializeDatabase,
  getTopArticlesForPersona,
  getViewpointsForArticle,
  saveDigest,
  getSubscribersByPersona,
  logAction,
} from "../db/operations";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// Output persona slugs that get daily digests
const DIGEST_PERSONAS = [
  { slug: "output-cio", label: "CIO" },
  { slug: "output-ciso", label: "CISO" },
  { slug: "output-sales-rep", label: "Sales Rep" },
  { slug: "output-general-hit", label: "Healthcare IT Professional" },
];

// Step 1: Gather top articles for each persona
const gatherArticlesStep = createStep({
  id: "gather-digest-articles",
  description: "Gathers top-ranked articles for each output persona from the last 24 hours",

  inputSchema: z.object({}),

  outputSchema: z.object({
    personaArticles: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📰 [Digest Step 1] Gathering articles for digests...");

    try {
      await initializeDatabase();

      await logAction(
        "TWH Digest Agent",
        "digest_workflow_started",
        "started",
        { timestamp: new Date().toISOString() }
      );

      const personaArticles: any[] = [];

      for (const persona of DIGEST_PERSONAS) {
        const articles = await getTopArticlesForPersona(persona.slug, 1, 7);

        // If no articles in last 24h, try 2 days
        const finalArticles = articles.length > 0
          ? articles
          : await getTopArticlesForPersona(persona.slug, 2, 7);

        // Get viewpoints for each article
        const articlesWithViewpoints = [];
        for (const article of finalArticles) {
          const viewpoints = await getViewpointsForArticle(article.id);
          articlesWithViewpoints.push({
            ...article,
            viewpoints,
          });
        }

        personaArticles.push({
          personaSlug: persona.slug,
          personaLabel: persona.label,
          articles: articlesWithViewpoints,
        });

        logger?.info(`✅ [Digest Step 1] ${persona.label}: ${articlesWithViewpoints.length} articles`);
      }

      return { personaArticles, success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Digest Step 1] Failed", { error: errorMessage });
      return { personaArticles: [], success: false, error: errorMessage };
    }
  },
});

// Step 2: Generate digest content for each persona
const generateDigestsStep = createStep({
  id: "generate-digests",
  description: "Generates narrative daily digest content for each persona using GPT-4o",

  inputSchema: z.object({
    personaArticles: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    digests: z.array(z.any()),
    digestsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("✍️ [Digest Step 2] Generating digest content...");

    if (!inputData.success || inputData.personaArticles.length === 0) {
      return { digests: [], digestsGenerated: 0, errors: 0, success: true };
    }

    const digests: any[] = [];
    let digestsGenerated = 0;
    let errors = 0;
    const today = new Date().toISOString().split("T")[0];

    for (const personaData of inputData.personaArticles) {
      if (personaData.articles.length === 0) {
        logger?.info(`ℹ️ [Digest Step 2] No articles for ${personaData.personaLabel}, skipping`);
        continue;
      }

      try {
        // Build article summaries for the prompt
        const articleSummaries = personaData.articles.map((a: any, i: number) => {
          const relevantViewpoint = a.viewpoints?.find(
            (v: any) => v.persona_slug === personaData.personaSlug
          );
          return `${i + 1}. "${a.title}" (Relevance: ${a.persona_relevance}/10)
   Summary: ${a.short_summary || "N/A"}
   Source: ${a.source_name || "Unknown"}
   ${relevantViewpoint ? `Persona Brief: ${relevantViewpoint.viewpoint_text?.slice(0, 500)}` : ""}
   Reason: ${a.relevance_reason || ""}`;
        }).join("\n\n");

        const digestPrompt = `You are writing a daily healthcare IT intelligence digest for a ${personaData.personaLabel}.

Today's date: ${today}

Here are the top ${personaData.articles.length} articles ranked by relevance to this persona:

${articleSummaries}

Generate a compelling daily digest that:
1. Opens with a 1-2 sentence executive summary of the day's most important theme
2. Covers each article with a brief paragraph explaining why it matters to a ${personaData.personaLabel}
3. Closes with a "Watch List" of 2-3 themes to monitor

Respond in JSON:
{
  "subjectLine": "A compelling email subject line (under 60 chars)",
  "highlights": ["highlight 1", "highlight 2", "highlight 3"],
  "digestText": "The full plain-text digest (use line breaks for readability)",
  "digestHtml": "The full HTML digest with simple formatting (<h2>, <p>, <ul>, <li>, <strong>, <a href>). Use inline styles for email compatibility. Include a clean, professional layout."
}`;

        const response = await generateText({
          model: openai("gpt-4o"),
          prompt: digestPrompt,
          temperature: 0.6,
        });

        const jsonMatch = response.text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("Failed to parse digest response");
        }

        const result = JSON.parse(jsonMatch[0]);
        const articleIds = personaData.articles.map((a: any) => a.id);

        const digestId = await saveDigest({
          personaSlug: personaData.personaSlug,
          digestDate: today,
          subjectLine: result.subjectLine,
          digestHtml: result.digestHtml,
          digestText: result.digestText,
          articleIds,
          highlights: result.highlights || [],
          modelUsed: "gpt-4o",
        });

        digests.push({
          digestId,
          personaSlug: personaData.personaSlug,
          personaLabel: personaData.personaLabel,
          subjectLine: result.subjectLine,
          articleCount: articleIds.length,
        });

        digestsGenerated++;
        logger?.info(`✅ [Digest Step 2] ${personaData.personaLabel} digest generated`, { digestId });
      } catch (error) {
        errors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error(`❌ [Digest Step 2] Failed for ${personaData.personaLabel}`, { error: errorMessage });
      }
    }

    return { digests, digestsGenerated, errors, success: true };
  },
});

// Step 3: Send digest emails to subscribers
const deliverDigestsStep = createStep({
  id: "deliver-digests",
  description: "Sends digest emails to active subscribers via Resend or SendGrid",

  inputSchema: z.object({
    digests: z.array(z.any()),
    digestsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    emailsSent: z.number(),
    emailsFailed: z.number(),
    digestsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📧 [Digest Step 3] Delivering digest emails...");

    let emailsSent = 0;
    let emailsFailed = 0;

    const resendApiKey = process.env.RESEND_API_KEY;
    const sendgridApiKey = process.env.SENDGRID_API_KEY;

    if (!resendApiKey && !sendgridApiKey) {
      logger?.warn("⚠️ [Digest Step 3] No email API key configured (RESEND_API_KEY or SENDGRID_API_KEY). Skipping delivery.");
      return {
        emailsSent: 0,
        emailsFailed: 0,
        digestsGenerated: inputData.digestsGenerated,
        errors: inputData.errors,
        success: true,
      };
    }

    for (const digest of inputData.digests) {
      try {
        const subscribers = await getSubscribersByPersona(digest.personaSlug);

        if (subscribers.length === 0) {
          logger?.info(`ℹ️ [Digest Step 3] No subscribers for ${digest.personaLabel}`);
          continue;
        }

        for (const subscriber of subscribers) {
          try {
            if (resendApiKey) {
              // Send via Resend
              const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${resendApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  from: process.env.DIGEST_FROM_EMAIL || "TWH Intelligence <digest@thisweekhealth.com>",
                  to: [subscriber.email],
                  subject: digest.subjectLine,
                  html: digest.digestHtml || digest.subjectLine,
                }),
              });

              if (!res.ok) {
                throw new Error(`Resend API error: ${res.status}`);
              }
            } else if (sendgridApiKey) {
              // Send via SendGrid
              const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${sendgridApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  personalizations: [{ to: [{ email: subscriber.email }] }],
                  from: { email: process.env.DIGEST_FROM_EMAIL || "digest@thisweekhealth.com" },
                  subject: digest.subjectLine,
                  content: [{ type: "text/html", value: digest.digestHtml || digest.subjectLine }],
                }),
              });

              if (!res.ok) {
                throw new Error(`SendGrid API error: ${res.status}`);
              }
            }

            emailsSent++;
          } catch (e) {
            emailsFailed++;
            logger?.warn(`⚠️ [Digest Step 3] Failed to send to ${subscriber.email}`, { error: String(e) });
          }
        }

        logger?.info(`✅ [Digest Step 3] ${digest.personaLabel}: sent to ${subscribers.length} subscribers`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error(`❌ [Digest Step 3] Delivery failed for ${digest.personaLabel}`, { error: errorMessage });
      }
    }

    await logAction(
      "TWH Digest Agent",
      "digest_workflow_completed",
      "success",
      {
        digestsGenerated: inputData.digestsGenerated,
        emailsSent,
        emailsFailed,
        timestamp: new Date().toISOString(),
      }
    );

    logger?.info("✅ [Digest Step 3] Delivery complete", { emailsSent, emailsFailed });

    return {
      emailsSent,
      emailsFailed,
      digestsGenerated: inputData.digestsGenerated,
      errors: inputData.errors,
      success: true,
    };
  },
});

// Create the digest workflow
export const digestWorkflow = createWorkflow({
  id: "twh-digest-workflow",

  inputSchema: z.object({}) as any,

  outputSchema: z.object({
    emailsSent: z.number(),
    emailsFailed: z.number(),
    digestsGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),
})
  .then(gatherArticlesStep as any)
  .then(generateDigestsStep as any)
  .then(deliverDigestsStep as any)
  .commit();
