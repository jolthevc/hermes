import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

// Direct (non-pooler) connection: the job queue relies on row locks across statements,
// which PgBouncer transaction pooling does not guarantee. Small pool; Neon autoscaling handles load.
const sqlClient = postgres(env.DATABASE_URL_DIRECT, { max: 5, prepare: false, onnotice: () => {} });

export const db = drizzle(sqlClient, { schema });
export const rawSql = sqlClient;
export type Db = typeof db;

export async function closeDb() {
  await sqlClient.end({ timeout: 5 });
}
