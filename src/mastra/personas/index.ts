import {
  ANALYST_PROMPTS,
  PERSONA_PROMPTS,
  OUTPUT_PERSONAS,
  routeToAnalyst,
} from "./prompts";

export {
  ANALYST_PROMPTS,
  PERSONA_PROMPTS,
  OUTPUT_PERSONAS,
  routeToAnalyst,
};

/**
 * Build an analyst system prompt, optionally enhanced with transcript excerpts.
 * Used for generating the analytical "view" on an article.
 */
export function buildPersonaPrompt(
  slug: string,
  transcriptExcerpts?: string[]
): string {
  const basePrompt = ANALYST_PROMPTS[slug];
  if (!basePrompt) {
    throw new Error(`Unknown analyst slug: ${slug}`);
  }

  if (!transcriptExcerpts || transcriptExcerpts.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}

## VOICE GUIDE FROM YOUR RECENT SHOWS
Use these real excerpts to match your authentic tone, phrasing, and speech patterns:
${transcriptExcerpts.map((excerpt, i) => `${i + 1}. "${excerpt}"`).join("\n")}

Draw on these excerpts to match your voice. Use similar phrasing and patterns naturally.`;
}

/**
 * Build an output persona brief prompt.
 * Combines the analyst's view with the output persona's framing.
 */
export function buildBriefPrompt(
  outputPersonaSlug: string,
  analystView: string,
  analystName: string,
  articleTitle: string,
  articleSummary: string,
  topicTags: string[]
): string {
  const persona = OUTPUT_PERSONAS[outputPersonaSlug];
  if (!persona) {
    throw new Error(`Unknown output persona: ${outputPersonaSlug}`);
  }

  return `${persona.prompt}

## ARTICLE
Title: ${articleTitle}
Summary: ${articleSummary}
Topics: ${topicTags.join(", ")}

## ANALYST VIEW (from ${analystName})
${analystView}

Generate the intelligence brief based on the analyst's view above, framed specifically for this persona. The analyst's perspective should inform your analysis but repackage it for the target audience.

Respond in JSON:
{
  "brief": "The full brief text (3-4 paragraphs, markdown formatted)",
  "headline": "A compelling 1-line headline for this brief (under 80 chars)",
  "keyTakeaways": ["takeaway 1", "takeaway 2", "takeaway 3"],
  "actionItems": ["specific action 1", "specific action 2"],
  "relevanceRating": "critical|high|medium|low"
}`;
}

/**
 * Get the list of individual analyst slugs.
 */
export function getIndividualPersonaSlugs(): string[] {
  return ["bill-russell", "drex-deford", "sarah-richardson"];
}

/**
 * Get all output persona slugs.
 */
export function getOutputPersonaSlugs(): string[] {
  return Object.keys(OUTPUT_PERSONAS);
}
