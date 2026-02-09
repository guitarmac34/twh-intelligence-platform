import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initializeDatabase() {
  console.log("📦 [Database] Initializing TWH Intelligence Platform schema...");
  
  const client = await pool.connect();
  
  try {
    await client.query(`
      -- Sources configuration table
      CREATE TABLE IF NOT EXISTS sources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('rss', 'sitemap', 'scrape')),
        rss_url TEXT,
        scrape_selector TEXT,
        check_frequency_minutes INT DEFAULT 15,
        priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
        enabled BOOLEAN DEFAULT true,
        last_check TIMESTAMP,
        error_count INT DEFAULT 0,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Articles table
      CREATE TABLE IF NOT EXISTS articles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
        url TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        published_date TIMESTAMP,
        scraped_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        raw_content TEXT,
        content_hash TEXT,
        processing_status TEXT DEFAULT 'scraped' CHECK (processing_status IN ('scraped', 'extracted', 'summarized', 'reviewed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Organizations (canonical entities)
      CREATE TABLE IF NOT EXISTS organizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        canonical_name TEXT UNIQUE NOT NULL,
        aliases TEXT[] DEFAULT '{}',
        type TEXT CHECK (type IN ('health_system', 'vendor', 'payer', 'startup', 'agency', 'other')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- People (canonical entities)
      CREATE TABLE IF NOT EXISTS people (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        title TEXT,
        organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Technologies (canonical entities)
      CREATE TABLE IF NOT EXISTS technologies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT UNIQUE NOT NULL,
        category TEXT CHECK (category IN ('EHR', 'cybersecurity', 'AI', 'interoperability', 'analytics', 'telehealth', 'cloud', 'other')),
        vendor_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Article-Organization junction table
      CREATE TABLE IF NOT EXISTS article_organizations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
        organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
        mention_type TEXT,
        confidence FLOAT DEFAULT 0.8,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(article_id, organization_id)
      );

      -- Article-People junction table
      CREATE TABLE IF NOT EXISTS article_people (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
        person_id UUID REFERENCES people(id) ON DELETE CASCADE,
        role_in_article TEXT,
        confidence FLOAT DEFAULT 0.8,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(article_id, person_id)
      );

      -- Article-Technology junction table
      CREATE TABLE IF NOT EXISTS article_technologies (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
        technology_id UUID REFERENCES technologies(id) ON DELETE CASCADE,
        context TEXT,
        confidence FLOAT DEFAULT 0.8,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(article_id, technology_id)
      );

      -- Summaries table
      CREATE TABLE IF NOT EXISTS summaries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id UUID UNIQUE REFERENCES articles(id) ON DELETE CASCADE,
        short_summary TEXT,
        key_takeaways TEXT[] DEFAULT '{}',
        topic_tags TEXT[] DEFAULT '{}',
        relevance_score INT CHECK (relevance_score >= 1 AND relevance_score <= 10),
        quality_rating INT,
        reviewed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Agent logs table
      CREATE TABLE IF NOT EXISTS agent_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        agent_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT CHECK (status IN ('started', 'success', 'error', 'warning')),
        details JSONB DEFAULT '{}',
        run_id TEXT
      );

      -- Personas table (TWH host perspectives)
      CREATE TABLE IF NOT EXISTS personas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        title TEXT,
        background TEXT,
        framework TEXT,
        show_names TEXT[] DEFAULT '{}',
        system_prompt TEXT NOT NULL,
        youtube_playlist_id TEXT,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- YouTube transcript storage
      CREATE TABLE IF NOT EXISTS transcripts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        persona_id UUID REFERENCES personas(id) ON DELETE CASCADE,
        video_id TEXT UNIQUE NOT NULL,
        video_title TEXT,
        video_url TEXT,
        published_date TIMESTAMP,
        raw_transcript TEXT,
        processed_excerpts JSONB DEFAULT '[]',
        topic_tags TEXT[] DEFAULT '{}',
        duration_seconds INT,
        processing_status TEXT DEFAULT 'raw' CHECK (processing_status IN ('raw', 'processed', 'error')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Per-article persona viewpoints
      CREATE TABLE IF NOT EXISTS viewpoints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
        persona_id UUID REFERENCES personas(id) ON DELETE CASCADE,
        viewpoint_text TEXT NOT NULL,
        key_insights TEXT[] DEFAULT '{}',
        confidence_score FLOAT DEFAULT 0.8,
        model_used TEXT DEFAULT 'gpt-4o-mini',
        generation_metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(article_id, persona_id)
      );

      -- Create indexes for performance
      CREATE INDEX IF NOT EXISTS idx_articles_content_hash ON articles(content_hash);
      CREATE INDEX IF NOT EXISTS idx_articles_processing_status ON articles(processing_status);
      CREATE INDEX IF NOT EXISTS idx_articles_source_id ON articles(source_id);
      CREATE INDEX IF NOT EXISTS idx_articles_published_date ON articles(published_date);
      CREATE INDEX IF NOT EXISTS idx_organizations_canonical_name ON organizations(canonical_name);
      CREATE INDEX IF NOT EXISTS idx_agent_logs_timestamp ON agent_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled);
      CREATE INDEX IF NOT EXISTS idx_transcripts_persona_id ON transcripts(persona_id);
      CREATE INDEX IF NOT EXISTS idx_transcripts_video_id ON transcripts(video_id);
      CREATE INDEX IF NOT EXISTS idx_transcripts_topic_tags ON transcripts USING GIN(topic_tags);
      CREATE INDEX IF NOT EXISTS idx_viewpoints_article_id ON viewpoints(article_id);
      CREATE INDEX IF NOT EXISTS idx_viewpoints_persona_id ON viewpoints(persona_id);
      CREATE INDEX IF NOT EXISTS idx_viewpoints_article_persona ON viewpoints(article_id, persona_id);
    `);

    console.log("✅ [Database] Schema initialized successfully");

    // Insert default healthcare IT news sources
    await seedDefaultSources(client);

    // Insert default personas
    await seedDefaultPersonas(client);
    
  } catch (error) {
    console.error("❌ [Database] Error initializing schema:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function seedDefaultSources(client: any) {
  console.log("🌱 [Database] Seeding default healthcare IT sources...");
  
  const defaultSources = [
    {
      name: "Healthcare IT News",
      url: "https://www.healthcareitnews.com",
      type: "rss",
      rss_url: "https://www.healthcareitnews.com/rss.xml",
      priority: "high",
    },
    {
      name: "HIMSS News",
      url: "https://www.himss.org/news",
      type: "scrape",
      scrape_selector: ".news-item",
      priority: "high",
    },
    {
      name: "Becker's Health IT",
      url: "https://www.beckershospitalreview.com/healthcare-information-technology.html",
      type: "scrape",
      scrape_selector: ".article-headline",
      priority: "high",
    },
    {
      name: "Health Data Management",
      url: "https://www.healthdatamanagement.com",
      type: "rss",
      rss_url: "https://www.healthdatamanagement.com/rss",
      priority: "medium",
    },
    {
      name: "CHIME Central",
      url: "https://chimecentral.org",
      type: "scrape",
      scrape_selector: ".news-article",
      priority: "medium",
    },
  ];

  for (const source of defaultSources) {
    try {
      await client.query(`
        INSERT INTO sources (name, url, type, rss_url, scrape_selector, priority)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [source.name, source.url, source.type, source.rss_url || null, source.scrape_selector || null, source.priority]);
    } catch (e) {
      // Ignore duplicate entries
    }
  }
  
  console.log("✅ [Database] Default sources seeded");
}

async function seedDefaultPersonas(client: any) {
  console.log("🎙️ [Database] Seeding default TWH personas...");

  const defaultPersonas = [
    {
      slug: "bill-russell",
      name: "Bill Russell",
      title: "CEO/Founder, This Week Health",
      background: "Former CIO of St. Joseph Health, a 16-hospital $6.5B health system. 26 years in IT consulting across telecom, banking, engineering. Founded This Week Health and the 229 Project. Hosts Keynote and Today shows.",
      framework: "Keep the trains running, lay new track, build airplanes",
      show_names: ["Keynote", "Today"],
      youtube_playlist_id: "PL8txvFFPu84xkfeoJbKMhUU9qO6nD3ZVJ",
    },
    {
      slug: "drex-deford",
      name: "Drex DeFord",
      title: "President, 229 Cyber & Risk",
      background: "20+ years U.S. Air Force including CTO for Air Force Health System worldwide operations. Former CIO at Scripps Health, Seattle Children's Hospital, Steward Health Care. Executive Healthcare Strategist at CrowdStrike. CHIME Board Chairman 2012. Hosts UnHack and 2-Minute Drill shows.",
      framework: "Cyber-safety is patient-safety",
      show_names: ["UnHack", "2-Minute Drill"],
      youtube_playlist_id: "PL8txvFFPu84y57y8Bx5IaI2XxnABDC_Qf",
    },
    {
      slug: "sarah-richardson",
      name: "Sarah Richardson",
      title: "President, 229 Executive Development",
      background: "Former CIO at HCA Healthcare (Division CIO, 10 years), NCH Healthcare System, VP of IT Change Leadership at OptumCare, SVP/CIO at Tivity Health. ICF-certified executive coach. CEO of Concierge Leadership. CHIME Fellow and Board Member. Hosts Flourish show.",
      framework: "Leadership and workforce transformation",
      show_names: ["Flourish"],
      youtube_playlist_id: "PL8txvFFPu84yV_ZrxBJSMx1R4aBJEpDmj",
    },
    {
      slug: "newsday",
      name: "Newsday Roundtable",
      title: "Combined Analysis - Bill, Drex & Sarah",
      background: "Weekly roundtable news discussion featuring all three TWH hosts analyzing healthcare IT news from complementary CIO perspectives: strategic, cybersecurity, and leadership.",
      framework: "Multi-perspective healthcare IT analysis",
      show_names: ["Newsday"],
      youtube_playlist_id: "PL8txvFFPu84zzu3G8povKr8Gu0sb87-mX",
    },
  ];

  for (const persona of defaultPersonas) {
    try {
      await client.query(`
        INSERT INTO personas (slug, name, title, background, framework, show_names, youtube_playlist_id, system_prompt)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          title = EXCLUDED.title,
          background = EXCLUDED.background,
          framework = EXCLUDED.framework,
          show_names = EXCLUDED.show_names,
          youtube_playlist_id = EXCLUDED.youtube_playlist_id,
          updated_at = CURRENT_TIMESTAMP
      `, [
        persona.slug,
        persona.name,
        persona.title,
        persona.background,
        persona.framework,
        persona.show_names,
        persona.youtube_playlist_id,
        `Persona prompt for ${persona.name} - loaded from application code`,
      ]);
    } catch (e) {
      // Ignore duplicate entries
    }
  }

  console.log("✅ [Database] Default personas seeded");
}

// Database query helper functions
export async function query(text: string, params?: any[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export { pool };
