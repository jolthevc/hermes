import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Load the repo-root .env (walk up from cwd). Real environment variables take precedence.
function loadDotEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, ".env");
    if (fs.existsSync(p) && fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      process.loadEnvFile(p);
      return;
    }
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
loadDotEnv();

const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const Env = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_URL_DIRECT: z.string().url(),
  OPENROUTER_API_KEY: optional,
  S3_ENDPOINT: optional,
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("hermes"),
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  GPU_BACKENDS: z.string().default("vast,runpod"),
  VAST_API_KEY: optional,
  RUNPOD_API_KEY: optional,
  SALAD_API_KEY: optional,
  SALAD_ORG: optional,
  SALAD_PROJECT: optional,
  APIFY_TOKEN: optional,
  SPEND_CAP_USD_DAILY: z.coerce.number().positive().default(20),
  SPEND_CAP_USD_PER_SKETCH: z.coerce.number().positive().default(1),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof Env>;

function parse(): Env {
  const r = Env.safeParse(process.env);
  if (!r.success) {
    // Never print values, only which variables are wrong.
    const bad = r.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${bad}. See .env.example.`);
  }
  return r.data;
}

export const env = parse();

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = env[key];
  if (v === undefined || v === null || v === "") throw new Error(`${String(key)} is not set (see .env.example)`);
  return v as NonNullable<Env[K]>;
}
