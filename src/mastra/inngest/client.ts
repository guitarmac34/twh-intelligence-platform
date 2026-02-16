import { Inngest } from "inngest";

const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || "4111";

let middleware: any[] = [];
if (!isProd) {
  try {
    const { realtimeMiddleware } = require("@inngest/realtime");
    middleware = [realtimeMiddleware()];
  } catch {
    // @inngest/realtime not available, skip
  }
}

export const inngest = new Inngest(
  isProd
    ? {
        id: "twh-intelligence-platform",
        name: "TWH Intelligence Platform",
      }
    : {
        id: "mastra",
        baseUrl: `http://localhost:${port}`,
        isDev: true,
        middleware,
      },
);
