import { query, initializeDatabase, pool } from "./schema";
import crypto from "crypto";

export { initializeDatabase };

// Get all enabled sources
export async function getSources() {
  const result = await query(
    "SELECT * FROM sources WHERE enabled = true ORDER BY priority DESC"
  );
  return result.rows;
}

// Check if article already exists
export async function checkArticleExists(contentHash: string, url: string) {
  const result = await query(
    `SELECT a.id, EXISTS(SELECT 1 FROM summaries s WHERE s.article_id = a.id) as has_summary
     FROM articles a WHERE a.content_hash = $1 OR a.url = $2`,
    [contentHash, url]
  );
  return {
    exists: result.rows.length > 0,
    articleId: result.rows[0]?.id,
    hasSummary: result.rows[0]?.has_summary === true,
  };
}

// Save an article
export async function saveArticle(article: {
  sourceId?: string;
  url: string;
  title: string;
  author?: string;
  publishedDate?: string;
  content?: string;
  contentHash: string;
}) {
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
    ]
  );
  return result.rows[0]?.id;
}

// Save entities and link to article
export async function saveEntities(
  articleId: string,
  organizations: any[],
  people: any[],
  technologies: any[]
) {
  // Save organizations and link to article
  for (const org of organizations) {
    const orgResult = await query(
      `INSERT INTO organizations (canonical_name, type)
       VALUES ($1, $2)
       ON CONFLICT (canonical_name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [org.canonicalName, org.type]
    );
    const orgId = orgResult.rows[0]?.id;

    if (orgId && articleId) {
      await query(
        `INSERT INTO article_organizations (article_id, organization_id, confidence)
         VALUES ($1, $2, $3)
         ON CONFLICT (article_id, organization_id) DO NOTHING`,
        [articleId, orgId, org.confidence]
      );
    }
  }

  // Save people and link to article
  for (const person of people) {
    let orgId = null;
    if (person.organization) {
      const orgResult = await query(
        `SELECT id FROM organizations WHERE canonical_name = $1`,
        [person.organization]
      );
      orgId = orgResult.rows[0]?.id;
    }

    const personResult = await query(
      `INSERT INTO people (name, title, organization_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [person.name, person.title || null, orgId]
    );

    let personId = personResult.rows[0]?.id;
    if (!personId) {
      const existingPerson = await query(
        `SELECT id FROM people WHERE name = $1`,
        [person.name]
      );
      personId = existingPerson.rows[0]?.id;
    }

    if (personId && articleId) {
      await query(
        `INSERT INTO article_people (article_id, person_id, confidence)
         VALUES ($1, $2, $3)
         ON CONFLICT (article_id, person_id) DO NOTHING`,
        [articleId, personId, person.confidence]
      );
    }
  }

  // Save technologies and link to article
  for (const tech of technologies) {
    let vendorId = null;
    if (tech.vendor) {
      const vendorResult = await query(
        `SELECT id FROM organizations WHERE canonical_name = $1`,
        [tech.vendor]
      );
      vendorId = vendorResult.rows[0]?.id;
    }

    const techResult = await query(
      `INSERT INTO technologies (name, category, vendor_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [tech.canonicalName, tech.category, vendorId]
    );
    const techId = techResult.rows[0]?.id;

    if (techId && articleId) {
      await query(
        `INSERT INTO article_technologies (article_id, technology_id, confidence)
         VALUES ($1, $2, $3)
         ON CONFLICT (article_id, technology_id) DO NOTHING`,
        [articleId, techId, tech.confidence]
      );
    }
  }

  // Update article status
  await query(
    `UPDATE articles SET processing_status = 'extracted', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [articleId]
  );
}

// Save summary
export async function saveSummary(
  articleId: string,
  summary: string,
  takeaways: string[],
  tags: string[],
  relevanceScore: number,
  qualityRating?: number
) {
  await query(
    `INSERT INTO summaries (article_id, short_summary, key_takeaways, topic_tags, relevance_score, quality_rating)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (article_id) DO UPDATE SET
       short_summary = EXCLUDED.short_summary,
       key_takeaways = EXCLUDED.key_takeaways,
       topic_tags = EXCLUDED.topic_tags,
       relevance_score = EXCLUDED.relevance_score,
       quality_rating = COALESCE(EXCLUDED.quality_rating, summaries.quality_rating),
       updated_at = CURRENT_TIMESTAMP`,
    [articleId, summary, takeaways, tags, relevanceScore, qualityRating || null]
  );

  await query(
    `UPDATE articles SET processing_status = 'summarized', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [articleId]
  );
}

// Log agent action
export async function logAction(
  agentName: string,
  action: string,
  status: string,
  details: any,
  runId?: string
) {
  await query(
    `INSERT INTO agent_logs (agent_name, action, status, details, run_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [agentName, action, status, details || {}, runId || null]
  );
}

// ======================================================================
// PERSONA & VIEWPOINT OPERATIONS
// ======================================================================

// Get all enabled personas
export async function getPersonas() {
  const result = await query(
    "SELECT * FROM personas WHERE enabled = true ORDER BY slug"
  );
  return result.rows;
}

// Get a persona by slug
export async function getPersonaBySlug(slug: string) {
  const result = await query(
    "SELECT * FROM personas WHERE slug = $1",
    [slug]
  );
  return result.rows[0] || null;
}

// Save a transcript
export async function saveTranscript(transcript: {
  personaId: string;
  videoId: string;
  videoTitle?: string;
  videoUrl?: string;
  publishedDate?: string;
  rawTranscript: string;
  durationSeconds?: number;
}) {
  const result = await query(
    `INSERT INTO transcripts (persona_id, video_id, video_title, video_url, published_date, raw_transcript, duration_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (video_id) DO UPDATE SET
       raw_transcript = EXCLUDED.raw_transcript,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [
      transcript.personaId,
      transcript.videoId,
      transcript.videoTitle || null,
      transcript.videoUrl || null,
      transcript.publishedDate ? new Date(transcript.publishedDate) : null,
      transcript.rawTranscript,
      transcript.durationSeconds || null,
    ]
  );
  return result.rows[0]?.id;
}

// Get transcripts for a persona, optionally filtered by topic tags
export async function getTranscriptsForPersona(personaId: string, topicTags?: string[]) {
  if (topicTags && topicTags.length > 0) {
    const result = await query(
      `SELECT * FROM transcripts
       WHERE persona_id = $1 AND processing_status = 'processed' AND topic_tags && $2
       ORDER BY published_date DESC LIMIT 10`,
      [personaId, topicTags]
    );
    return result.rows;
  }

  const result = await query(
    `SELECT * FROM transcripts
     WHERE persona_id = $1 AND processing_status = 'processed'
     ORDER BY published_date DESC LIMIT 10`,
    [personaId]
  );
  return result.rows;
}

// Save a viewpoint
export async function saveViewpoint(viewpoint: {
  articleId: string;
  personaId: string;
  viewpointText: string;
  keyInsights: string[];
  confidenceScore: number;
  modelUsed?: string;
  generationMetadata?: any;
}) {
  const result = await query(
    `INSERT INTO viewpoints (article_id, persona_id, viewpoint_text, key_insights, confidence_score, model_used, generation_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (article_id, persona_id) DO UPDATE SET
       viewpoint_text = EXCLUDED.viewpoint_text,
       key_insights = EXCLUDED.key_insights,
       confidence_score = EXCLUDED.confidence_score,
       model_used = EXCLUDED.model_used,
       generation_metadata = EXCLUDED.generation_metadata,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [
      viewpoint.articleId,
      viewpoint.personaId,
      viewpoint.viewpointText,
      viewpoint.keyInsights,
      viewpoint.confidenceScore,
      viewpoint.modelUsed || "gpt-4o-mini",
      viewpoint.generationMetadata || {},
    ]
  );
  return result.rows[0]?.id;
}

// Get all viewpoints for an article
export async function getViewpointsForArticle(articleId: string) {
  const result = await query(
    `SELECT v.*, p.name as persona_name, p.slug as persona_slug, p.title as persona_title, p.framework as persona_framework
     FROM viewpoints v
     JOIN personas p ON v.persona_id = p.id
     WHERE v.article_id = $1
     ORDER BY p.slug`,
    [articleId]
  );
  return result.rows;
}

// Get articles that have summaries but are missing viewpoints
export async function getArticlesNeedingViewpoints(limit: number = 20) {
  const result = await query(
    `SELECT a.id, a.title, a.url, a.raw_content,
            s.short_summary, s.key_takeaways, s.topic_tags, s.relevance_score
     FROM articles a
     JOIN summaries s ON s.article_id = a.id
     WHERE s.relevance_score >= 6
       AND a.id NOT IN (
         SELECT DISTINCT article_id FROM viewpoints
         WHERE persona_id IN (SELECT id FROM personas WHERE slug != 'newsday' AND enabled = true)
       )
     ORDER BY s.relevance_score DESC, a.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Get articles that have all 3 individual viewpoints but no Newsday roundtable
export async function getArticlesNeedingRoundtable() {
  const result = await query(
    `SELECT a.id, a.title
     FROM articles a
     WHERE (
       SELECT COUNT(DISTINCT v.persona_id)
       FROM viewpoints v
       JOIN personas p ON v.persona_id = p.id
       WHERE v.article_id = a.id AND p.slug != 'newsday' AND p.enabled = true
     ) = 3
     AND a.id NOT IN (
       SELECT v2.article_id FROM viewpoints v2
       JOIN personas p2 ON v2.persona_id = p2.id
       WHERE p2.slug = 'newsday'
     )
     ORDER BY a.created_at DESC
     LIMIT 20`
  );
  return result.rows;
}

// Increment error count on a source
export async function incrementSourceErrorCount(sourceId: string) {
  await query(
    `UPDATE sources SET error_count = error_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [sourceId]
  );
}

// ======================================================================
// PERSONA ARTICLE SCORING
// ======================================================================

// Save persona relevance scores for an article (bulk insert)
export async function savePersonaScores(
  articleId: string,
  scores: Array<{ personaSlug: string; relevanceScore: number; relevanceReason: string }>
) {
  for (const score of scores) {
    await query(
      `INSERT INTO persona_article_scores (article_id, persona_slug, relevance_score, relevance_reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (article_id, persona_slug) DO UPDATE SET
         relevance_score = EXCLUDED.relevance_score,
         relevance_reason = EXCLUDED.relevance_reason`,
      [articleId, score.personaSlug, score.relevanceScore, score.relevanceReason]
    );
  }
}

// Get top articles for a persona, ranked by relevance
export async function getTopArticlesForPersona(
  personaSlug: string,
  days: number = 1,
  limit: number = 7
) {
  const result = await query(
    `SELECT a.id, a.title, a.url, a.published_date, a.created_at,
            s.short_summary, s.key_takeaways, s.topic_tags, s.relevance_score as overall_relevance,
            pas.relevance_score as persona_relevance, pas.relevance_reason,
            src.name as source_name
     FROM persona_article_scores pas
     JOIN articles a ON pas.article_id = a.id
     LEFT JOIN summaries s ON a.id = s.article_id
     LEFT JOIN sources src ON a.source_id = src.id
     WHERE pas.persona_slug = $1
       AND a.created_at >= NOW() - INTERVAL '1 day' * $2
     ORDER BY pas.relevance_score DESC, a.created_at DESC
     LIMIT $3`,
    [personaSlug, days, limit]
  );
  return result.rows;
}

// Get articles with persona scores, with optional filtering
export async function getArticlesWithPersonaScores(filters: {
  personaSlug?: string;
  minRelevance?: number;
  days?: number;
  tag?: string;
  source?: string;
  page?: number;
  limit?: number;
}) {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramCount = 0;

  if (filters.personaSlug) {
    paramCount++;
    conditions.push(`pas.persona_slug = $${paramCount}`);
    params.push(filters.personaSlug);
  }
  if (filters.minRelevance) {
    paramCount++;
    conditions.push(`pas.relevance_score >= $${paramCount}`);
    params.push(filters.minRelevance);
  }
  if (filters.days) {
    paramCount++;
    conditions.push(`a.created_at >= NOW() - INTERVAL '1 day' * $${paramCount}`);
    params.push(filters.days);
  }
  if (filters.tag) {
    paramCount++;
    conditions.push(`$${paramCount} = ANY(s.topic_tags)`);
    params.push(filters.tag);
  }
  if (filters.source) {
    paramCount++;
    conditions.push(`src.name ILIKE $${paramCount}`);
    params.push(`%${filters.source}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const pageLimit = filters.limit || 20;
  const offset = ((filters.page || 1) - 1) * pageLimit;

  paramCount++;
  const limitParam = paramCount;
  params.push(pageLimit);
  paramCount++;
  const offsetParam = paramCount;
  params.push(offset);

  const result = await query(
    `SELECT a.id, a.title, a.url, a.published_date, a.created_at,
            s.short_summary, s.topic_tags, s.relevance_score as overall_relevance,
            pas.relevance_score as persona_relevance, pas.relevance_reason, pas.persona_slug,
            src.name as source_name
     FROM articles a
     LEFT JOIN persona_article_scores pas ON a.id = pas.article_id
     LEFT JOIN summaries s ON a.id = s.article_id
     LEFT JOIN sources src ON a.source_id = src.id
     ${whereClause}
     ORDER BY COALESCE(pas.relevance_score, s.relevance_score, 0) DESC, a.created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  );
  return result.rows;
}

// ======================================================================
// DIGEST OPERATIONS
// ======================================================================

// Save a digest
export async function saveDigest(digest: {
  personaSlug: string;
  digestDate: string;
  subjectLine: string;
  digestHtml: string;
  digestText: string;
  articleIds: string[];
  highlights: string[];
  modelUsed?: string;
}) {
  const result = await query(
    `INSERT INTO digests (persona_slug, digest_date, subject_line, digest_html, digest_text, article_ids, highlights, model_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (persona_slug, digest_date) DO UPDATE SET
       subject_line = EXCLUDED.subject_line,
       digest_html = EXCLUDED.digest_html,
       digest_text = EXCLUDED.digest_text,
       article_ids = EXCLUDED.article_ids,
       highlights = EXCLUDED.highlights,
       model_used = EXCLUDED.model_used
     RETURNING id`,
    [
      digest.personaSlug,
      digest.digestDate,
      digest.subjectLine,
      digest.digestHtml,
      digest.digestText,
      digest.articleIds,
      digest.highlights,
      digest.modelUsed || "gpt-4o",
    ]
  );
  return result.rows[0]?.id;
}

// Get latest digest for persona
export async function getLatestDigest(personaSlug: string) {
  const result = await query(
    `SELECT * FROM digests WHERE persona_slug = $1 ORDER BY digest_date DESC LIMIT 1`,
    [personaSlug]
  );
  return result.rows[0] || null;
}

// Get digest history
export async function getDigestHistory(personaSlug: string, days: number = 7) {
  const result = await query(
    `SELECT id, persona_slug, digest_date, subject_line, highlights, model_used, created_at
     FROM digests WHERE persona_slug = $1 AND digest_date >= CURRENT_DATE - $2
     ORDER BY digest_date DESC`,
    [personaSlug, days]
  );
  return result.rows;
}

// ======================================================================
// SUBSCRIBER OPERATIONS
// ======================================================================

export async function addSubscriber(email: string, personaSlugs: string[]) {
  const result = await query(
    `INSERT INTO digest_subscribers (email, persona_slugs)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       persona_slugs = EXCLUDED.persona_slugs,
       active = true,
       updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [email, personaSlugs]
  );
  return result.rows[0];
}

export async function removeSubscriber(email: string) {
  await query(
    `UPDATE digest_subscribers SET active = false, updated_at = CURRENT_TIMESTAMP WHERE email = $1`,
    [email]
  );
}

export async function getActiveSubscribers() {
  const result = await query(
    `SELECT * FROM digest_subscribers WHERE active = true ORDER BY email`
  );
  return result.rows;
}

export async function getSubscribersByPersona(personaSlug: string) {
  const result = await query(
    `SELECT * FROM digest_subscribers WHERE active = true AND $1 = ANY(persona_slugs)`,
    [personaSlug]
  );
  return result.rows;
}

// ======================================================================
// ACCOUNT OPERATIONS (Sales Enablement)
// ======================================================================

export async function getAccounts() {
  const result = await query(
    `SELECT a.*,
            o.canonical_name as organization_name,
            (SELECT COUNT(*) FROM account_articles WHERE account_id = a.id) as article_count
     FROM accounts a
     LEFT JOIN organizations o ON a.organization_id = o.id
     ORDER BY a.updated_at DESC`
  );
  return result.rows;
}

export async function getAccountById(id: string) {
  const result = await query(
    `SELECT a.*,
            o.canonical_name as organization_name
     FROM accounts a
     LEFT JOIN organizations o ON a.organization_id = o.id
     WHERE a.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function createAccount(account: {
  name: string;
  type: string;
  industrySegment?: string;
  size?: string;
  region?: string;
  keyContacts?: any[];
  notes?: string;
  owner?: string;
}) {
  // Try to find matching organization
  const orgResult = await query(
    `SELECT id FROM organizations WHERE canonical_name ILIKE $1 LIMIT 1`,
    [account.name]
  );
  const organizationId = orgResult.rows[0]?.id || null;

  const result = await query(
    `INSERT INTO accounts (organization_id, name, type, industry_segment, size, region, key_contacts, notes, owner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      organizationId,
      account.name,
      account.type,
      account.industrySegment || null,
      account.size || null,
      account.region || null,
      JSON.stringify(account.keyContacts || []),
      account.notes || null,
      account.owner || null,
    ]
  );
  return result.rows[0];
}

export async function updateAccount(id: string, updates: Record<string, any>) {
  const result = await query(
    `UPDATE accounts SET
       name = COALESCE($1, name),
       type = COALESCE($2, type),
       industry_segment = COALESCE($3, industry_segment),
       size = COALESCE($4, size),
       region = COALESCE($5, region),
       key_contacts = COALESCE($6, key_contacts),
       notes = COALESCE($7, notes),
       owner = COALESCE($8, owner),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = $9
     RETURNING *`,
    [
      updates.name,
      updates.type,
      updates.industrySegment,
      updates.size,
      updates.region,
      updates.keyContacts ? JSON.stringify(updates.keyContacts) : null,
      updates.notes,
      updates.owner,
      id,
    ]
  );
  return result.rows[0];
}

export async function deleteAccount(id: string) {
  await query(`DELETE FROM accounts WHERE id = $1`, [id]);
}

export async function getAccountArticles(accountId: string) {
  const result = await query(
    `SELECT a.id, a.title, a.url, a.published_date, a.created_at,
            s.short_summary, s.topic_tags, s.relevance_score,
            aa.match_type, aa.relevance_note, aa.created_at as linked_at,
            src.name as source_name
     FROM account_articles aa
     JOIN articles a ON aa.article_id = a.id
     LEFT JOIN summaries s ON a.id = s.article_id
     LEFT JOIN sources src ON a.source_id = src.id
     WHERE aa.account_id = $1
     ORDER BY a.created_at DESC`,
    [accountId]
  );
  return result.rows;
}

export async function linkArticleToAccount(accountId: string, articleId: string, matchType: string, relevanceNote?: string) {
  await query(
    `INSERT INTO account_articles (account_id, article_id, match_type, relevance_note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, article_id) DO NOTHING`,
    [accountId, articleId, matchType, relevanceNote || null]
  );
}

// Auto-link: find accounts matching extracted organizations
export async function autoLinkArticleToAccounts(articleId: string, organizationNames: string[]) {
  for (const orgName of organizationNames) {
    // Match by organization_id or fuzzy name match
    const accounts = await query(
      `SELECT a.id FROM accounts a
       LEFT JOIN organizations o ON a.organization_id = o.id
       WHERE o.canonical_name ILIKE $1 OR a.name ILIKE $1`,
      [orgName]
    );
    for (const account of accounts.rows) {
      await linkArticleToAccount(account.id, articleId, "auto", `Matched organization: ${orgName}`);
    }
  }
}

// Full-text search across articles
export async function searchArticles(searchQuery: string, personaSlug?: string, limit: number = 20) {
  if (personaSlug) {
    const result = await query(
      `SELECT a.id, a.title, a.url, a.published_date, a.created_at,
              s.short_summary, s.topic_tags, s.relevance_score,
              pas.relevance_score as persona_relevance,
              ts_rank(to_tsvector('english', COALESCE(a.title, '') || ' ' || COALESCE(a.raw_content, '')), plainto_tsquery('english', $1)) as search_rank,
              src.name as source_name
       FROM articles a
       LEFT JOIN summaries s ON a.id = s.article_id
       LEFT JOIN persona_article_scores pas ON a.id = pas.article_id AND pas.persona_slug = $2
       LEFT JOIN sources src ON a.source_id = src.id
       WHERE to_tsvector('english', COALESCE(a.title, '') || ' ' || COALESCE(a.raw_content, '')) @@ plainto_tsquery('english', $1)
       ORDER BY search_rank DESC
       LIMIT $3`,
      [searchQuery, personaSlug, limit]
    );
    return result.rows;
  }

  const result = await query(
    `SELECT a.id, a.title, a.url, a.published_date, a.created_at,
            s.short_summary, s.topic_tags, s.relevance_score,
            ts_rank(to_tsvector('english', COALESCE(a.title, '') || ' ' || COALESCE(a.raw_content, '')), plainto_tsquery('english', $1)) as search_rank,
            src.name as source_name
     FROM articles a
     LEFT JOIN summaries s ON a.id = s.article_id
     LEFT JOIN sources src ON a.source_id = src.id
     WHERE to_tsvector('english', COALESCE(a.title, '') || ' ' || COALESCE(a.raw_content, '')) @@ plainto_tsquery('english', $1)
     ORDER BY search_rank DESC
     LIMIT $2`,
    [searchQuery, limit]
  );
  return result.rows;
}

// Helper to extract text from potentially nested RSS title objects
function extractTitle(title: any): string {
  if (typeof title === "string") {
    return title;
  }
  if (title && typeof title === "object") {
    // Handle Fierce Healthcare style: {a: [{_: "Title text", $: {...}}]}
    if (title.a && Array.isArray(title.a) && title.a[0]) {
      return title.a[0]._ || title.a[0] || "Untitled";
    }
    // Handle other nested structures
    if (title._ ) {
      return title._;
    }
    // Try to stringify and extract text
    const str = JSON.stringify(title);
    const match = str.match(/"_":"([^"]+)"/);
    if (match) return match[1];
  }
  return "Untitled";
}

// Helper to parse various date formats
function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  
  // Try standard Date parsing first
  let date = new Date(dateStr);
  if (!isNaN(date.getTime())) {
    return date;
  }
  
  // Handle Fierce Healthcare format: "Feb 4, 2026 12:56pm"
  const fierceDateMatch = dateStr.match(/^(\w+)\s+(\d+),\s+(\d+)\s+(\d+):(\d+)(am|pm)$/i);
  if (fierceDateMatch) {
    const [, month, day, year, hour, minute, ampm] = fierceDateMatch;
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };
    const monthNum = months[month.toLowerCase()];
    let hourNum = parseInt(hour);
    if (ampm.toLowerCase() === 'pm' && hourNum < 12) hourNum += 12;
    if (ampm.toLowerCase() === 'am' && hourNum === 12) hourNum = 0;
    
    date = new Date(parseInt(year), monthNum, parseInt(day), hourNum, parseInt(minute));
    if (!isNaN(date.getTime())) {
      return date;
    }
  }
  
  return null;
}

// Scrape RSS feed
export async function scrapeRssFeed(url: string, maxItems: number = 25) {
  const Parser = (await import("rss-parser")).default;
  const parser = new Parser({
    timeout: 30000,
    headers: { "User-Agent": "TWH-Intelligence-Agent/1.0" },
  });

  const feed = await parser.parseURL(url);
  
  const maxAgeDays = parseInt(process.env.ARTICLE_MAX_AGE_DAYS || "30", 10);
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  return feed.items
    .filter((item) => {
      const rawDate = item.pubDate || item.isoDate;
      if (!rawDate) return true; // Keep items without dates
      const parsed = parseDate(rawDate);
      return !parsed || parsed >= cutoffDate;
    })
    .slice(0, maxItems)
    .map((item) => {
      const content = item.contentSnippet || item.content || item.summary || "";
      const title = extractTitle(item.title);
      const rawDate = item.pubDate || item.isoDate;
      const parsedDate = parseDate(rawDate);
      return {
        title,
        url: item.link || url,
        author: item.creator || item.author || undefined,
        publishedDate: parsedDate ? parsedDate.toISOString() : undefined,
        content: content,
        contentHash: crypto.createHash("md5").update(content).digest("hex"),
        sourceName: feed.title || new URL(url).hostname,
      };
    });
}

// Scrape HTML page
export async function scrapeHtmlPage(url: string, selector?: string, maxItems: number = 25) {
  const cheerio = await import("cheerio");
  
  const response = await fetch(url, {
    headers: {
      "User-Agent": "TWH-Intelligence-Agent/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const articles: any[] = [];

  const sel = selector || "article, .article, .post, .news-item";
  const elements = $(sel).slice(0, maxItems);

  elements.each((_, element) => {
    const $el = $(element);
    const title =
      $el.find("h1, h2, h3, .title, .headline").first().text().trim() ||
      $el.text().slice(0, 100).trim();
    const link =
      $el.find("a").first().attr("href") ||
      $el.attr("href") ||
      url;
    const fullLink = link.startsWith("http")
      ? link
      : new URL(link, url).href;
    const content = $el.text().trim();

    if (title && title.length > 5) {
      articles.push({
        title,
        url: fullLink,
        author: undefined,
        publishedDate: undefined,
        content,
        contentHash: crypto.createHash("md5").update(content).digest("hex"),
        sourceName: new URL(url).hostname,
      });
    }
  });

  return articles;
}
