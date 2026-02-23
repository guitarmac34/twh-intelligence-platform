import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Email delivery tool for sending digest emails via Resend or SendGrid.
 * Used by the digest workflow to deliver daily intelligence briefs.
 */
export const emailDeliveryTool = createTool({
  id: "email-delivery",
  description: "Sends an email via Resend or SendGrid API",
  inputSchema: z.object({
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    html: z.string().describe("HTML email body"),
    text: z.string().optional().describe("Plain text fallback"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    provider: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { to, subject, html, text } = context;
    const resendApiKey = process.env.RESEND_API_KEY;
    const sendgridApiKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.DIGEST_FROM_EMAIL || "TWH Intelligence <digest@thisweekhealth.com>";

    if (!resendApiKey && !sendgridApiKey) {
      return { success: false, error: "No email API key configured" };
    }

    try {
      if (resendApiKey) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [to],
            subject,
            html,
            text: text || undefined,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { success: false, provider: "resend", error: `HTTP ${res.status}: ${body}` };
        }

        return { success: true, provider: "resend" };
      }

      if (sendgridApiKey) {
        const content: any[] = [{ type: "text/html", value: html }];
        if (text) {
          content.unshift({ type: "text/plain", value: text });
        }

        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sendgridApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: fromEmail.replace(/<(.+)>/, "$1").trim() },
            subject,
            content,
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          return { success: false, provider: "sendgrid", error: `HTTP ${res.status}: ${body}` };
        }

        return { success: true, provider: "sendgrid" };
      }

      return { success: false, error: "No email provider available" };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
