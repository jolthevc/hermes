import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../env.js";

const client = postgres(env.DATABASE_URL_DIRECT, { max: 1, onnotice: () => {} });
await migrate(drizzle(client), { migrationsFolder: "packages/core/migrations" });
await client.end();
console.log("migrations applied");
