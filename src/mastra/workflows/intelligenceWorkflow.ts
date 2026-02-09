import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { researcherAgent } from "../agents/researcherAgent";
import {
  initializeDatabase,
  getSources,
  checkArticleExists,
  saveArticle,
  saveEntities,
  saveSummary,
  logAction,
  scrapeRssFeed,
  scrapeHtmlPage,
} from "../db/operations";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// Canonical dictionaries for entity normalization
const ORGANIZATION_ALIASES: Record<string, string> = {
  "cerner": "Oracle Health",
  "cerner corporation": "Oracle Health",
  "oracle cerner": "Oracle Health",
  "epic systems": "Epic",
  "epic systems corporation": "Epic",
  "microsoft corporation": "Microsoft",
  "hca healthcare": "HCA",
  "commonspirit health": "CommonSpirit",
  "office of the national coordinator": "ONC",
  "centers for medicare and medicaid services": "CMS",
};

const TECHNOLOGY_ALIASES: Record<string, string> = {
  "fast healthcare interoperability resources": "FHIR",
  "health level seven": "HL7",
  "electronic health record": "EHR",
  "artificial intelligence": "AI",
};

// Step 1: Initialize database and load sources
const loadSourcesStep = createStep({
  id: "load-sources",
  description: "Initializes database and loads the list of enabled news sources to monitor",

  inputSchema: z.object({}),

  outputSchema: z.object({
    sources: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🚀 [Step 1] Loading sources...");

    try {
      await initializeDatabase();

      await logAction(
        "TWH Intelligence Agent",
        "workflow_started",
        "started",
        { timestamp: new Date().toISOString() }
      );

      const sources = await getSources();

      logger?.info("✅ [Step 1] Sources loaded", { count: sources.length });

      return { sources, success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [Step 1] Failed to load sources", { error: errorMessage });
      return { sources: [], success: false, error: errorMessage };
    }
  },
});

// Step 2: Monitor sources and scrape new content
const monitorSourcesStep = createStep({
  id: "monitor-sources",
  description: "Scrapes content from all enabled sources and collects new articles",

  inputSchema: z.object({
    sources: z.array(z.any()),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    articles: z.array(z.any()),
    success: z.boolean(),
    sourcesProcessed: z.number(),
    error: z.string().optional(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [Step 2] Monitoring sources for new content...");

    if (!inputData.success || inputData.sources.length === 0) {
      logger?.warn("⚠️ [Step 2] No sources available to monitor");
      return {
        articles: [],
        success: false,
        sourcesProcessed: 0,
        error: inputData.error || "No sources available",
      };
    }

    const allArticles: any[] = [];
    let sourcesProcessed = 0;

    for (const source of inputData.sources) {
      try {
        logger?.info(`📡 [Step 2] Scraping source: ${source.name}`);

        let articles: any[] = [];
        
        if (source.type === "rss" && source.rss_url) {
          articles = await scrapeRssFeed(source.rss_url, 10);
        } else {
          articles = await scrapeHtmlPage(source.url, source.scrape_selector, 10);
        }

        if (articles.length > 0) {
          const articlesWithSource = articles.map((article: any) => ({
            ...article,
            sourceId: source.id,
          }));
          allArticles.push(...articlesWithSource);
          sourcesProcessed++;
          logger?.info(`✅ [Step 2] Scraped ${articles.length} articles from ${source.name}`);
        } else {
          logger?.warn(`⚠️ [Step 2] No articles from ${source.name}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error(`❌ [Step 2] Error scraping ${source.name}`, { error: errorMessage });
      }
    }

    logger?.info("✅ [Step 2] Source monitoring complete", {
      totalArticles: allArticles.length,
      sourcesProcessed,
    });

    return {
      articles: allArticles,
      success: true,
      sourcesProcessed,
    };
  },
});

// Step 3: Filter out duplicate/already processed content
const filterContentStep = createStep({
  id: "filter-content",
  description: "Filters out articles that have already been processed or are duplicates",

  inputSchema: z.object({
    articles: z.array(z.any()),
    success: z.boolean(),
    sourcesProcessed: z.number(),
    error: z.string().optional(),
  }),

  outputSchema: z.object({
    newArticles: z.array(z.any()),
    duplicatesSkipped: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔄 [Step 3] Filtering duplicate content...");

    if (!inputData.success || inputData.articles.length === 0) {
      return { newArticles: [], duplicatesSkipped: 0, success: true };
    }

    const newArticles: any[] = [];
    let duplicatesSkipped = 0;

    for (const article of inputData.articles) {
      const checkResult = await checkArticleExists(article.contentHash, article.url);

      if (!checkResult.exists) {
        newArticles.push(article);
      } else {
        duplicatesSkipped++;
      }
    }

    logger?.info("✅ [Step 3] Filtering complete", {
      newArticles: newArticles.length,
      duplicatesSkipped,
    });

    return {
      newArticles,
      duplicatesSkipped,
      success: true,
    };
  },
});

// Step 4: Process articles - extract entities and generate summaries
const processArticlesStep = createStep({
  id: "process-articles",
  description: "Processes each new article: extracts entities, normalizes them, and generates AI summaries",

  inputSchema: z.object({
    newArticles: z.array(z.any()),
    duplicatesSkipped: z.number(),
    success: z.boolean(),
  }),

  outputSchema: z.object({
    processedArticles: z.array(z.any()),
    success: z.boolean(),
    totalProcessed: z.number(),
    errors: z.number(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔬 [Step 4] Processing articles with AI...");

    if (inputData.newArticles.length === 0) {
      logger?.info("ℹ️ [Step 4] No new articles to process");
      return { processedArticles: [], success: true, totalProcessed: 0, errors: 0 };
    }

    const processedArticles: any[] = [];
    let errors = 0;

    for (const article of inputData.newArticles) {
      try {
        logger?.info(`📝 [Step 4] Processing: ${article.title.slice(0, 50)}...`);

        // 1. Save the article first
        const articleId = await saveArticle({
          sourceId: article.sourceId,
          url: article.url,
          title: article.title,
          author: article.author,
          publishedDate: article.publishedDate,
          content: article.content,
          contentHash: article.contentHash,
        });

        // 2. Extract entities using AI
        const extractPrompt = `Extract entities from this healthcare IT article.

ARTICLE TITLE: ${article.title}

ARTICLE CONTENT:
${(article.content || "").slice(0, 4000)}

Extract:
1. Organizations (health_system, vendor, payer, startup, agency, other)
2. People (with titles and org affiliations)
3. Technologies (EHR, cybersecurity, AI, interoperability, analytics, telehealth, cloud, other)

Respond with JSON only:
{
  "organizations": [{"name": "...", "type": "vendor", "confidence": 0.9}],
  "people": [{"name": "...", "title": "...", "organization": "...", "confidence": 0.9}],
  "technologies": [{"name": "...", "category": "EHR", "vendor": "...", "confidence": 0.9}]
}`;

        let entitiesExtracted = 0;
        try {
          const extractResponse = await generateText({
            model: openai("gpt-4o-mini"),
            prompt: extractPrompt,
            temperature: 0.2,
          });

          const jsonMatch = extractResponse.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const extracted = JSON.parse(jsonMatch[0]);

            // Normalize entities
            const normalizedOrgs = (extracted.organizations || []).map((org: any) => {
              const lowerName = org.name.toLowerCase().trim();
              const canonical = ORGANIZATION_ALIASES[lowerName];
              return {
                canonicalName: canonical || org.name,
                type: org.type,
                confidence: org.confidence,
              };
            });

            const normalizedPeople = (extracted.people || []).map((person: any) => {
              let normalizedOrg = person.organization;
              if (normalizedOrg) {
                const lowerOrg = normalizedOrg.toLowerCase().trim();
                normalizedOrg = ORGANIZATION_ALIASES[lowerOrg] || normalizedOrg;
              }
              return {
                name: person.name,
                title: person.title,
                organization: normalizedOrg,
                confidence: person.confidence,
              };
            });

            const normalizedTech = (extracted.technologies || []).map((tech: any) => {
              const lowerName = tech.name.toLowerCase().trim();
              const canonical = TECHNOLOGY_ALIASES[lowerName];
              return {
                canonicalName: canonical || tech.name,
                category: tech.category,
                vendor: tech.vendor,
                confidence: tech.confidence,
              };
            });

            // Save entities
            await saveEntities(articleId, normalizedOrgs, normalizedPeople, normalizedTech);
            entitiesExtracted = normalizedOrgs.length + normalizedPeople.length + normalizedTech.length;
          }
        } catch (e) {
          logger?.warn("⚠️ [Step 4] Entity extraction failed", { error: String(e) });
        }

        // 3. Generate summary using the agent
        let hasSummary = false;
        try {
          const summaryResponse = await researcherAgent.generateLegacy([
            {
              role: "user",
              content: `Analyze this healthcare IT article and provide:
1. A 2-3 sentence summary of what happened, who is involved, and why it matters
2. 3-5 key takeaways for healthcare IT sales/marketing teams
3. Topic tags (choose from: cybersecurity, AI, EHR, interoperability, telehealth, analytics, cloud, regulation, M&A, partnership, funding, leadership)
4. A relevance score 1-10 (10 = highly relevant for healthcare IT vendors)

ARTICLE TITLE: ${article.title}

ARTICLE CONTENT:
${(article.content || "").slice(0, 3000)}

Respond in this exact JSON format:
{
  "summary": "2-3 sentence summary here",
  "takeaways": ["takeaway 1", "takeaway 2", "takeaway 3"],
  "tags": ["tag1", "tag2"],
  "relevanceScore": 8
}`,
            },
          ]);

          const jsonMatch = summaryResponse.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const summaryData = JSON.parse(jsonMatch[0]);
            await saveSummary(
              articleId,
              summaryData.summary,
              summaryData.takeaways || [],
              summaryData.tags || [],
              summaryData.relevanceScore || 5
            );
            hasSummary = true;
          }
        } catch (e) {
          logger?.warn("⚠️ [Step 4] Summary generation failed", { error: String(e) });
        }

        processedArticles.push({
          articleId,
          title: article.title,
          entitiesExtracted,
          hasSummary,
        });

        logger?.info(`✅ [Step 4] Processed article`, {
          articleId,
          entities: entitiesExtracted,
          hasSummary,
        });
      } catch (error) {
        errors++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger?.error(`❌ [Step 4] Error processing article`, {
          title: article.title,
          error: errorMessage,
        });
      }
    }

    logger?.info("✅ [Step 4] Article processing complete", {
      processed: processedArticles.length,
      errors,
    });

    return {
      processedArticles,
      success: true,
      totalProcessed: processedArticles.length,
      errors,
    };
  },
});

// Step 5: Store results and log completion
const storeResultsStep = createStep({
  id: "store-results",
  description: "Logs the workflow completion and stores final statistics",

  inputSchema: z.object({
    processedArticles: z.array(z.any()),
    success: z.boolean(),
    totalProcessed: z.number(),
    errors: z.number(),
  }),

  outputSchema: z.object({
    summary: z.string(),
    articlesProcessed: z.number(),
    entitiesExtracted: z.number(),
    summariesGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("💾 [Step 5] Storing results and logging completion...");

    const totalEntities = inputData.processedArticles.reduce(
      (sum: number, a: any) => sum + (a.entitiesExtracted || 0),
      0
    );
    const totalSummaries = inputData.processedArticles.filter((a: any) => a.hasSummary).length;

    await logAction(
      "TWH Intelligence Agent",
      "workflow_completed",
      "success",
      {
        articlesProcessed: inputData.totalProcessed,
        entitiesExtracted: totalEntities,
        summariesGenerated: totalSummaries,
        errors: inputData.errors,
        timestamp: new Date().toISOString(),
      }
    );

    const summary = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 TWH INTELLIGENCE AGENT - RUN COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📰 Articles Processed: ${inputData.totalProcessed}
🏢 Entities Extracted: ${totalEntities}
📝 Summaries Generated: ${totalSummaries}
❌ Errors: ${inputData.errors}

Timestamp: ${new Date().toISOString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    logger?.info(summary);

    return {
      summary,
      articlesProcessed: inputData.totalProcessed,
      entitiesExtracted: totalEntities,
      summariesGenerated: totalSummaries,
      errors: inputData.errors,
      success: true,
    };
  },
});

// Create the workflow
export const intelligenceWorkflow = createWorkflow({
  id: "twh-intelligence-workflow",

  inputSchema: z.object({}) as any,

  outputSchema: z.object({
    summary: z.string(),
    articlesProcessed: z.number(),
    entitiesExtracted: z.number(),
    summariesGenerated: z.number(),
    errors: z.number(),
    success: z.boolean(),
  }),
})
  .then(loadSourcesStep as any)
  .then(monitorSourcesStep as any)
  .then(filterContentStep as any)
  .then(processArticlesStep as any)
  .then(storeResultsStep as any)
  .commit();
