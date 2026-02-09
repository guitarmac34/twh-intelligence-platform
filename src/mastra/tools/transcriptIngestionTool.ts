import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getPersonaBySlug, saveTranscript } from "../db/operations";

export const transcriptIngestionTool = createTool({
  id: "transcript-ingestion",
  description:
    "Fetches YouTube transcripts from a TWH persona playlist and stores them in the database for persona enhancement.",

  inputSchema: z.object({
    playlistId: z.string().describe("YouTube playlist ID"),
    personaSlug: z
      .string()
      .describe("Persona slug to associate transcripts with"),
    maxVideos: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of videos to process"),
  }),

  outputSchema: z.object({
    videosProcessed: z.number(),
    transcriptsSaved: z.number(),
    errors: z.number(),
    success: z.boolean(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📺 [transcriptIngestion] Starting transcript ingestion", {
      playlistId: context.playlistId,
      personaSlug: context.personaSlug,
      maxVideos: context.maxVideos,
    });

    let videosProcessed = 0;
    let transcriptsSaved = 0;
    let errors = 0;

    try {
      // Look up the persona
      const persona = await getPersonaBySlug(context.personaSlug);
      if (!persona) {
        return {
          videosProcessed: 0,
          transcriptsSaved: 0,
          errors: 1,
          success: false,
          error: `Persona not found: ${context.personaSlug}`,
        };
      }

      // Dynamically import ytpl to get playlist videos
      let ytpl: any;
      try {
        ytpl = (await import("ytpl")).default;
      } catch {
        ytpl = await import("ytpl");
      }

      logger?.info("📺 [transcriptIngestion] Fetching playlist", {
        playlistId: context.playlistId,
      });

      const playlist = await ytpl(context.playlistId, {
        limit: context.maxVideos || 20,
      });

      logger?.info("📺 [transcriptIngestion] Playlist loaded", {
        title: playlist.title,
        videoCount: playlist.items.length,
      });

      // Dynamically import youtube-transcript
      let YoutubeTranscript: any;
      try {
        const ytModule = await import("youtube-transcript");
        YoutubeTranscript =
          (ytModule as any).YoutubeTranscript ||
          (ytModule as any).default?.YoutubeTranscript;
      } catch {
        return {
          videosProcessed: 0,
          transcriptsSaved: 0,
          errors: 1,
          success: false,
          error: "youtube-transcript package not available",
        };
      }

      for (const item of playlist.items) {
        videosProcessed++;

        try {
          logger?.info("📺 [transcriptIngestion] Fetching transcript", {
            videoId: item.id,
            title: item.title,
          });

          const transcriptParts = await YoutubeTranscript.fetchTranscript(
            item.id,
          );
          const fullTranscript = transcriptParts
            .map((part: any) => part.text)
            .join(" ");

          if (fullTranscript && fullTranscript.length > 50) {
            await saveTranscript({
              personaId: persona.id,
              videoId: item.id,
              videoTitle: item.title,
              videoUrl: item.url,
              publishedDate: undefined,
              rawTranscript: fullTranscript,
              durationSeconds: item.durationSec || undefined,
            });

            transcriptsSaved++;
            logger?.info("✅ [transcriptIngestion] Transcript saved", {
              videoId: item.id,
              length: fullTranscript.length,
            });
          } else {
            logger?.warn(
              "⚠️ [transcriptIngestion] Transcript too short or empty",
              {
                videoId: item.id,
              },
            );
          }
        } catch (videoError) {
          errors++;
          const errorMsg =
            videoError instanceof Error
              ? videoError.message
              : String(videoError);
          logger?.warn("⚠️ [transcriptIngestion] Failed to process video", {
            videoId: item.id,
            error: errorMsg,
          });
        }
      }

      logger?.info("✅ [transcriptIngestion] Ingestion complete", {
        videosProcessed,
        transcriptsSaved,
        errors,
      });

      return {
        videosProcessed,
        transcriptsSaved,
        errors,
        success: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger?.error("❌ [transcriptIngestion] Ingestion failed", {
        error: errorMessage,
      });

      return {
        videosProcessed,
        transcriptsSaved,
        errors: errors + 1,
        success: false,
        error: errorMessage,
      };
    }
  },
});
