import { defineConfig } from "drizzle-kit";
import { env } from "./src/env.js";

export default defineConfig({
  schema: "./packages/core/src/db/schema.ts",
  out: "./packages/core/migrations",
  dialect: "postgresql",
  dbCredentials: { url: env.DATABASE_URL_DIRECT },
});
