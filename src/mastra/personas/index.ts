import { PERSONA_PROMPTS } from "./prompts";

export { PERSONA_PROMPTS };

/**
 * Build a full persona system prompt, optionally enhanced with transcript excerpts.
 * The base prompt comes from PERSONA_PROMPTS, and relevant transcript quotes
 * are appended to give the persona more authentic, current voice.
 */
export function buildPersonaPrompt(
  slug: string,
  transcriptExcerpts?: string[]
): string {
  const basePrompt = PERSONA_PROMPTS[slug];
  if (!basePrompt) {
    throw new Error(`Unknown persona slug: ${slug}`);
  }

  if (!transcriptExcerpts || transcriptExcerpts.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}

## RECENT SHOW EXCERPTS (use these to inform your voice and stay current)
${transcriptExcerpts.map((excerpt, i) => `${i + 1}. "${excerpt}"`).join("\n")}

Draw on these excerpts to inform your perspective. Reference specific points when relevant, but analyze the current article through your own analytical framework.`;
}

/**
 * Get the list of individual persona slugs (excluding the newsday roundtable).
 */
export function getIndividualPersonaSlugs(): string[] {
  return ["bill-russell", "drex-deford", "sarah-richardson"];
}
