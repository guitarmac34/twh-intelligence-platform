import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import Parser from "rss-parser";
import * as cheerio from "cheerio";
import crypto from "crypto";

const rssParser = new Parser({
  timeout: 30000,
  headers: {
    "User-Agent": "TWH-Intelligence-Agent/1.0",
  },
});

export const webScraperTool = createTool({
  id: "web-scraper",
  description:
    "Scrapes content from websites using RSS feeds or direct web scraping. Use this to fetch articles and content from healthcare IT news sources.",

  inputSchema: z.object({
    url: z.string().describe("The URL to scrape (website or RSS feed)"),
    type: z
      .enum(["rss", "scrape"])
      .describe(
        "The type of scraping: 'rss' for RSS feeds, 'scrape' for direct HTML scraping",
      ),
    selector: z
      .string()
      .optional()
      .describe(
        "CSS selector for direct scraping (required when type is 'scrape')",
      ),
    maxItems: z
      .number()
      .optional()
      .default(10)
      .describe("Maximum number of items to return"),
  }),

  outputSchema: z.object({
    articles: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        author: z.string().optional(),
        publishedDate: z.string().optional(),
        content: z.string().optional(),
        contentHash: z.string(),
        sourceName: z.string(),
      }),
    ),
    success: z.boolean(),
    error: z.string().optional(),
    itemCount: z.number(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔧 [webScraperTool] Starting scrape", {
      url: context.url,
      type: context.type,
    });

    try {
      let articles: any[] = [];

      if (context.type === "rss") {
        logger?.info("📡 [webScraperTool] Parsing RSS feed...");
        const feed = await rssParser.parseURL(context.url);

        articles = feed.items.slice(0, context.maxItems).map((item) => {
          const content =
            item.contentSnippet || item.content || item.summary || "";
          return {
            title: item.title || "Untitled",
            url: item.link || context.url,
            author: item.creator || item.author || undefined,
            publishedDate: item.pubDate || item.isoDate || undefined,
            content: content,
            contentHash: crypto.createHash("md5").update(content).digest("hex"),
            sourceName: feed.title || new URL(context.url).hostname,
          };
        });
      } else if (context.type === "scrape") {
        logger?.info("🌐 [webScraperTool] Direct HTML scraping...");

        const response = await fetch(context.url, {
          headers: {
            "User-Agent": "TWH-Intelligence-Agent/1.0",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const selector =
          context.selector || "article, .article, .post, .news-item";
        const elements = $(selector).slice(0, context.maxItems);

        elements.each((_, element) => {
          const $el = $(element);
          const title =
            $el.find("h1, h2, h3, .title, .headline").first().text().trim() ||
            $el.text().slice(0, 100).trim();
          const link =
            $el.find("a").first().attr("href") ||
            $el.attr("href") ||
            context.url;
          const fullLink = link.startsWith("http")
            ? link
            : new URL(link, context.url).href;
          const content = $el.text().trim();

          if (title && title.length > 5) {
            articles.push({
              title,
              url: fullLink,
              author: undefined,
              publishedDate: undefined,
              content: content.slice(0, 2000),
              contentHash: crypto
                .createHash("md5")
                .update(content)
                .digest("hex"),
              sourceName: new URL(context.url).hostname,
            });
          }
        });
      }

      logger?.info("✅ [webScraperTool] Scraping complete", {
        itemCount: articles.length,
      });

      return {
        articles,
        success: true,
        itemCount: articles.length,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error("❌ [webScraperTool] Scraping failed", {
        error: errorMessage,
      });

      return {
        articles: [],
        success: false,
        error: errorMessage,
        itemCount: 0,
      };
    }
  },
});
