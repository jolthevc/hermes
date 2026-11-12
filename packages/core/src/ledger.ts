import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { costLedger, sketches } from "./db/schema.js";
import { env } from "./env.js";
import { HermesError } from "./errors.js";

export interface CostContext {
  showId?: string | null;
  sketchId?: string | null;
  jobId?: number | null;
  stage: string;
}

export interface CostEntry extends CostContext {
  role?: string;
  provider: string;
  model?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  gpuSeconds?: number | null;
  usd: number;
  meta?: Record<string, unknown>;
}

export async function recordCost(e: CostEntry) {
  await db.insert(costLedger).values({
    showId: e.showId ?? null,
    sketchId: e.sketchId ?? null,
    jobId: e.jobId ?? null,
    stage: e.stage,
    role: e.role,
    provider: e.provider,
    model: e.model,
    promptTokens: e.promptTokens ?? null,
    completionTokens: e.completionTokens ?? null,
    reasoningTokens: e.reasoningTokens ?? null,
    cachedTokens: e.cachedTokens ?? null,
    gpuSeconds: e.gpuSeconds ?? null,
    usd: e.usd,
    meta: e.meta ?? {},
  });
  if (e.sketchId && e.usd) {
    await db
      .update(sketches)
      .set({ costUsd: sql`${sketches.costUsd} + ${e.usd}` })
      .where(eq(sketches.id, e.sketchId));
  }
}

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

export async function spentToday(showId?: string): Promise<number> {
  const where = showId
    ? and(gte(costLedger.ts, startOfUtcDay()), eq(costLedger.showId, showId))
    : gte(costLedger.ts, startOfUtcDay());
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${costLedger.usd}), 0)` })
    .from(costLedger)
    .where(where);
  return Number(row?.total ?? 0);
}

export async function spentOnSketch(sketchId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${costLedger.usd}), 0)` })
    .from(costLedger)
    .where(eq(costLedger.sketchId, sketchId));
  return Number(row?.total ?? 0);
}

/** Throws a non-retryable budget error if any cap is exceeded. Call before every paid operation. */
export async function assertBudget(ctx: CostContext, opts: { showDailyBudgetUsd?: number } = {}) {
  const global = await spentToday();
  if (global >= env.SPEND_CAP_USD_DAILY) {
    throw new HermesError(`Global daily cap reached ($${global.toFixed(2)} / $${env.SPEND_CAP_USD_DAILY})`, "budget");
  }
  if (ctx.showId && opts.showDailyBudgetUsd !== undefined) {
    const show = await spentToday(ctx.showId);
    if (show >= opts.showDailyBudgetUsd) {
      throw new HermesError(`Show ${ctx.showId} daily budget reached ($${show.toFixed(2)})`, "budget");
    }
  }
  if (ctx.sketchId) {
    const s = await spentOnSketch(ctx.sketchId);
    if (s >= env.SPEND_CAP_USD_PER_SKETCH) {
      throw new HermesError(`Sketch cap reached ($${s.toFixed(3)} / $${env.SPEND_CAP_USD_PER_SKETCH})`, "budget");
    }
  }
}
