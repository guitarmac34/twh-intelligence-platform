import { PostgresStore } from "@mastra/pg";

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set.");
  console.error("In Railway: link your PostgreSQL service to this app, or set DATABASE_URL manually.");
}

// Create a single shared PostgreSQL storage instance
export const sharedPostgresStorage = new PostgresStore({
  connectionString: process.env.DATABASE_URL!,
});
