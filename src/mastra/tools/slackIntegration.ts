/**
 * TWH Slack Integration
 *
 * Connects to a private Slack channel so you can share links and get
 * persona viewpoints posted back as threaded replies.
 *
 * SETUP:
 * 1. Go to https://api.slack.com/apps → Create New App → From Scratch
 * 2. Name: "TWH Intelligence Bot", pick your workspace
 * 3. OAuth & Permissions → Bot Token Scopes → Add:
 *    - chat:write        (post messages)
 *    - channels:history   (read public channel messages)
 *    - groups:history     (read private channel messages)
 *    - links:read         (see URLs in messages)
 * 4. Install to Workspace → Copy Bot User OAuth Token
 * 5. Set env var: SLACK_BOT_TOKEN=xoxb-your-token
 * 6. Set env var: SLACK_CHANNEL_ID=C0123456789 (your private channel ID)
 * 7. Event Subscriptions → Enable → Request URL: https://your-domain/api/slack/events
 * 8. Subscribe to bot events: message.channels, message.groups
 * 9. Invite the bot to your private channel: /invite @TWH Intelligence Bot
 */

import { WebClient } from "@slack/web-api";

let slackClient: WebClient | null = null;

export function getSlackClient(): WebClient | null {
  if (!process.env.SLACK_BOT_TOKEN) return null;
  if (!slackClient) {
    slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  }
  return slackClient;
}

/**
 * Extract URLs from a Slack message.
 * Slack wraps URLs in angle brackets: <https://example.com>
 * or with label: <https://example.com|example.com>
 */
export function extractUrlsFromSlackMessage(text: string): string[] {
  const urlPattern = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g;
  const urls: string[] = [];
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

/**
 * Post a formatted viewpoint response back to Slack as a threaded reply.
 */
export async function postViewpointToSlack(
  channel: string,
  threadTs: string,
  articleResult: {
    title: string;
    articleId: string;
    summary: string | null;
    relevanceScore: number | null;
    tags: string[];
    viewpointsGenerated: number;
  },
  viewpoints: Array<{
    persona_name: string;
    persona_slug: string;
    viewpoint_text: string;
    key_insights: string[];
  }>,
) {
  const slack = getSlackClient();
  if (!slack) return;

  // Post summary first
  await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `📰 ${articleResult.title}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Summary:* ${articleResult.summary || "N/A"}\n*Relevance:* ${articleResult.relevanceScore || "N/A"}/10\n*Tags:* ${articleResult.tags.join(", ") || "None"}`,
        },
      },
      { type: "divider" },
    ] as any,
    text: `Analysis: ${articleResult.title}`,
  });

  // Post each persona viewpoint as a separate threaded reply
  const personaEmojis: Record<string, string> = {
    "bill-russell": "🎯",
    "drex-deford": "🔒",
    "sarah-richardson": "👥",
    newsday: "📺",
  };

  for (const vp of viewpoints) {
    const emoji = personaEmojis[vp.persona_slug] || "🗣️";
    const insights = vp.key_insights.map((i: string) => `• ${i}`).join("\n");

    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${emoji} *${vp.persona_name}*\n\n${vp.viewpoint_text}`,
          },
        },
        ...(insights
          ? [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Key Insights:*\n${insights}`,
                },
              },
            ]
          : []),
      ] as any,
      text: `${vp.persona_name}: ${vp.viewpoint_text.slice(0, 100)}...`,
    });
  }
}
