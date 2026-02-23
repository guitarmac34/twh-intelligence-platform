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

      -- Per-persona article relevance scores
      CREATE TABLE IF NOT EXISTS persona_article_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
        persona_slug TEXT NOT NULL,
        relevance_score INT CHECK (relevance_score >= 1 AND relevance_score <= 10),
        relevance_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(article_id, persona_slug)
      );

      -- Daily digest storage
      CREATE TABLE IF NOT EXISTS digests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        persona_slug TEXT NOT NULL,
        digest_date DATE NOT NULL,
        subject_line TEXT NOT NULL,
        digest_html TEXT NOT NULL,
        digest_text TEXT NOT NULL,
        article_ids UUID[] DEFAULT '{}',
        highlights TEXT[] DEFAULT '{}',
        model_used TEXT DEFAULT 'gpt-4o',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(persona_slug, digest_date)
      );

      -- Digest email subscribers
      CREATE TABLE IF NOT EXISTS digest_subscribers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        persona_slugs TEXT[] NOT NULL DEFAULT '{}',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(email)
      );

      -- Sales enablement accounts
      CREATE TABLE IF NOT EXISTS accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES organizations(id),
        name TEXT NOT NULL,
        type TEXT CHECK (type IN ('prospect', 'customer', 'competitor', 'partner')),
        industry_segment TEXT,
        size TEXT,
        region TEXT,
        key_contacts JSONB DEFAULT '[]',
        notes TEXT,
        owner TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Account-article linkage for sales intelligence
      CREATE TABLE IF NOT EXISTS account_articles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
        article_id UUID REFERENCES articles(id) ON DELETE CASCADE,
        match_type TEXT CHECK (match_type IN ('auto', 'manual')),
        relevance_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, article_id)
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

      -- Indexes for new tables
      CREATE INDEX IF NOT EXISTS idx_persona_scores_article ON persona_article_scores(article_id);
      CREATE INDEX IF NOT EXISTS idx_persona_scores_slug ON persona_article_scores(persona_slug);
      CREATE INDEX IF NOT EXISTS idx_persona_scores_relevance ON persona_article_scores(persona_slug, relevance_score DESC);
      CREATE INDEX IF NOT EXISTS idx_digests_persona_date ON digests(persona_slug, digest_date DESC);
      CREATE INDEX IF NOT EXISTS idx_subscribers_active ON digest_subscribers(active);
      CREATE INDEX IF NOT EXISTS idx_accounts_org ON accounts(organization_id);
      CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);
      CREATE INDEX IF NOT EXISTS idx_account_articles_account ON account_articles(account_id);
      CREATE INDEX IF NOT EXISTS idx_account_articles_article ON account_articles(article_id);
      CREATE INDEX IF NOT EXISTS idx_articles_fulltext ON articles USING GIN(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(raw_content, '')));
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
  
  // All sources verified working as of Feb 2026.
  // Each RSS URL tested with curl — returns valid XML.
  // Scrape sources tested — returns valid HTML with working selectors.
  // Sources behind Cloudflare/DataDome (HIMSS, CHIME, EHR Intelligence,
  // Modern Healthcare) excluded — they block server-side fetches.
  const defaultSources = [
    // === TIER 1: Core Healthcare IT (verified RSS feeds) ===
    {
      name: "Healthcare IT News",
      url: "https://www.healthcareitnews.com",
      type: "rss",
      rss_url: "https://www.healthcareitnews.com/rss.xml",
      priority: "high",
    },
    {
      name: "Healthcare IT News - Cybersecurity",
      url: "https://www.healthcareitnews.com",
      type: "rss",
      rss_url: "https://www.healthcareitnews.com/rss/cybersecurity.xml",
      priority: "high",
    },
    {
      name: "FierceHealthcare",
      url: "https://www.fiercehealthcare.com",
      type: "rss",
      rss_url: "https://www.fiercehealthcare.com/rss/xml",
      priority: "high",
    },
    {
      name: "Healthcare Dive",
      url: "https://www.healthcaredive.com",
      type: "rss",
      rss_url: "https://www.healthcaredive.com/feeds/news/",
      priority: "high",
    },
    {
      name: "Healthcare Dive - Health IT",
      url: "https://www.healthcaredive.com",
      type: "rss",
      rss_url: "https://www.healthcaredive.com/feeds/topic/health-it/",
      priority: "high",
    },
    {
      name: "Becker's Health IT",
      url: "https://www.beckershospitalreview.com/healthcare-information-technology.html",
      type: "scrape",
      scrape_selector: "article.bh-card",
      priority: "high",
    },
    // === TIER 2: Broader Health + Tech (verified RSS feeds) ===
    {
      name: "STAT News - Health Tech",
      url: "https://www.statnews.com/category/health-tech/",
      type: "rss",
      rss_url: "https://www.statnews.com/category/health-tech/feed/",
      priority: "high",
    },
    {
      name: "MobiHealthNews",
      url: "https://www.mobihealthnews.com",
      type: "rss",
      rss_url: "https://www.mobihealthnews.com/rss.xml",
      priority: "high",
    },
    {
      name: "HIT Consultant",
      url: "https://hitconsultant.net",
      type: "rss",
      rss_url: "https://hitconsultant.net/feed/",
      priority: "medium",
    },
    {
      name: "HealthTech Magazine",
      url: "https://healthtechmagazine.net",
      type: "rss",
      rss_url: "https://healthtechmagazine.net/rss.xml",
      priority: "medium",
    },
    {
      name: "Healthcare Finance News",
      url: "https://www.healthcarefinancenews.com",
      type: "rss",
      rss_url: "https://www.healthcarefinancenews.com/rss.xml",
      priority: "medium",
    },
    {
      name: "HealthcareITToday",
      url: "https://www.healthcareittoday.com",
      type: "rss",
      rss_url: "https://www.healthcareittoday.com/feed/",
      priority: "medium",
    },
    // === TIER 3: Policy, Cybersecurity & Regulatory (verified feeds) ===
    {
      name: "Health Affairs",
      url: "https://www.healthaffairs.org",
      type: "rss",
      rss_url: "https://www.healthaffairs.org/action/showFeed?type=etoc&feed=rss&jc=hlthaff",
      priority: "medium",
    },
    {
      name: "KFF Health News",
      url: "https://kffhealthnews.org",
      type: "rss",
      rss_url: "https://khn.org/feed/",
      priority: "medium",
    },
    {
      name: "CISA Cybersecurity Advisories",
      url: "https://www.cisa.gov/cybersecurity-advisories",
      type: "rss",
      rss_url: "https://www.cisa.gov/cybersecurity-advisories/all.xml",
      priority: "high",
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
    // Output personas (brief recipients)
    {
      slug: "output-cio",
      name: "CIO Brief",
      title: "Chief Information Officer",
      background: "Strategic IT leader responsible for technology decisions, vendor relationships, budget, and digital transformation at a health system.",
      framework: "Output persona",
      show_names: [],
      youtube_playlist_id: null,
    },
    {
      slug: "output-ciso",
      name: "CISO Brief",
      title: "Chief Information Security Officer",
      background: "Security leader responsible for cybersecurity posture, risk management, compliance, and incident response at a health system.",
      framework: "Output persona",
      show_names: [],
      youtube_playlist_id: null,
    },
    {
      slug: "output-sales-rep",
      name: "Vendor Sales Brief",
      title: "Healthcare IT Sales Representative",
      background: "Vendor sales rep selling technology solutions (EHR, cybersecurity, cloud, AI) into health systems. Needs buyer intelligence and positioning angles.",
      framework: "Output persona",
      show_names: [],
      youtube_playlist_id: null,
    },
    {
      slug: "output-general-hit",
      name: "Healthcare IT Brief",
      title: "General Healthcare IT Professional",
      background: "Anyone working in healthcare IT who needs to stay current on industry trends for career relevance.",
      framework: "Output persona",
      show_names: [],
      youtube_playlist_id: null,
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
