# TWH Intelligence Platform

## Overview

A **Role-Based Autonomous Agent** (Level 4 autonomy) that owns the responsibility of continuously monitoring healthcare IT news sources, scraping content, extracting structured intelligence, and storing it for analysis.

**Core Function:** An autonomous agent that:
1. Monitors healthcare IT news sources (RSS feeds, websites)
2. Scrapes new articles and content as they appear
3. Extracts structured entities (organizations, people, technologies)
4. Generates AI-powered summaries with healthcare IT context
5. Stores everything in a searchable PostgreSQL database

## Recent Changes

- **2026-02-04**: Initial implementation of TWH Intelligence Agent
  - Created database schema with tables for articles, organizations, people, technologies, summaries, and agent logs
  - Implemented web scraping for RSS feeds and HTML pages
  - Built AI-powered entity extraction and normalization
  - Created researcher agent with healthcare IT domain expertise
  - Built 5-step workflow: load sources → monitor → filter → process → store
  - Configured time-based trigger (every 4 hours by default)

## Project Architecture

### Directory Structure

```
src/
├── mastra/
│   ├── agents/
│   │   └── researcherAgent.ts      # Healthcare IT researcher agent
│   ├── db/
│   │   ├── schema.ts               # Database schema definitions
│   │   └── operations.ts           # Database operation functions
│   ├── tools/
│   │   ├── webScraperTool.ts       # RSS and HTML scraping
│   │   ├── entityExtractorTool.ts  # AI entity extraction
│   │   ├── entityNormalizerTool.ts # Canonical name normalization
│   │   └── databaseTool.ts         # Database operations tool
│   ├── workflows/
│   │   └── intelligenceWorkflow.ts # Main automation workflow
│   ├── inngest/                    # Inngest integration
│   ├── storage/                    # PostgreSQL storage config
│   └── index.ts                    # Mastra instance & cron trigger
├── triggers/
│   └── cronTriggers.ts             # Cron trigger registration
└── tests/
    └── testCronAutomation.ts       # Manual trigger test
```

### Database Schema

- **sources**: News source configurations (RSS feeds, websites)
- **articles**: Scraped articles with content and metadata
- **organizations**: Canonical entities (health systems, vendors, payers, etc.)
- **people**: People entities with titles and affiliations
- **technologies**: Tech entities (EHR, AI, cybersecurity, etc.)
- **summaries**: AI-generated article summaries and tags
- **agent_logs**: Workflow execution logs

### Workflow Steps

1. **load-sources**: Initialize database and load enabled sources
2. **monitor-sources**: Scrape content from all sources
3. **filter-content**: Deduplicate using content hashing
4. **process-articles**: Extract entities, normalize, generate summaries
5. **store-results**: Log completion and statistics

## Configuration

### Cron Schedule

Default: Every 4 hours (`0 */4 * * *`)

Override with environment variable:
```
SCHEDULE_CRON_EXPRESSION="0 8 * * *"  # Daily at 8 AM UTC
```

### LLM Configuration

Uses Replit AI Integrations (OpenAI) - no API key required, billed to credits.

## Testing

Run manual trigger test:
```bash
npx tsx tests/testCronAutomation.ts
```

## User Preferences

- Healthcare IT domain focus
- Entity normalization with canonical dictionaries
- Relevance scoring (1-10) for vendor sales teams
- Topic tagging for filtering
