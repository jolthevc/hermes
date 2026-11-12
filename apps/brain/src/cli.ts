import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderText, ShotScript } from "@hermes/agents";
import { closeDb, db, queue, schema, spentToday } from "@hermes/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { enqueueStage, startSketch } from "./orchestrator.js";
import { SKETCH_STAGES, type SketchStage } from "./pipeline.js";
import { HANDLERS } from "./stages.js";
import { runLoop } from "./worker.js";

const { shows, showVersions, premises, sketches, shotScripts, jobs, costLedger, ideationBatches } = schema;

const HELP = `hermes <command> [options]

Shows
  show:import <id> --from <dir> [--name "Name"]   import bible.md + kit.json as an approved version
  show:list
  show:set <id> [--mode autopilot|manual|paused] [--daily-target N] [--budget USD] [--publish on|off]

Writing
  ideate --show <id> [--count 10] [--auto-start N] [--batch-tag T]   queue an ideation job
  premises --show <id>                            list the latest batch of premises
  sketch:start --premise <id> [--batch-tag T]     start a sketch from a premise

Running
  run [--until-idle] [--concurrency 3]            process jobs
  resume                                          re-enqueue sketches waiting at a stage that now has a handler
  jobs:retry <jobId>                              requeue a dead job

Inspecting
  status [--show <id>]                            sketches by state/stage, queue depth, spend today
  sketch:show <id>                                shot script as text + cost breakdown
  cost [--show <id>]                              spend by stage and model
`;

const [cmd, ...rest] = process.argv.slice(2);
const { values: o, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    from: { type: "string" },
    name: { type: "string" },
    mode: { type: "string" },
    "daily-target": { type: "string" },
    budget: { type: "string" },
    publish: { type: "string" },
    show: { type: "string" },
    count: { type: "string" },
    "auto-start": { type: "string" },
    "batch-tag": { type: "string" },
    premise: { type: "string" },
    "until-idle": { type: "boolean" },
    concurrency: { type: "string" },
  },
});

const usd = (n: number) => `$${n.toFixed(4)}`;

async function main() {
  switch (cmd) {
    case "show:import": {
      const id = positionals[0]!;
      const dir = o.from ?? `writing-test/shows/${id}`;
      const bible = fs.readFileSync(path.join(dir, "bible.md"), "utf8");
      const kitPath = path.join(dir, "kit.json");
      const kit = fs.existsSync(kitPath) ? JSON.parse(fs.readFileSync(kitPath, "utf8")) : { actions: [] };
      await db
        .insert(shows)
        .values({ id, name: o.name ?? id, status: "live" })
        .onConflictDoNothing();
      const [last] = await db
        .select({ v: sql<number>`coalesce(max(${showVersions.version}), 0)::int` })
        .from(showVersions)
        .where(eq(showVersions.showId, id));
      const version = (last?.v ?? 0) + 1;
      await db.insert(showVersions).values({
        showId: id,
        version,
        bible,
        kit: { actions: kit.actions ?? [] },
        approvedAt: new Date(),
        approvedBy: "import",
      });
      await db.update(shows).set({ currentVersion: version, status: "live" }).where(eq(shows.id, id));
      console.log(`imported ${id} as v${version}`);
      break;
    }
    case "show:list": {
      console.table(await db.select().from(shows));
      break;
    }
    case "show:set": {
      const id = positionals[0]!;
      const patch: Partial<typeof shows.$inferInsert> = {};
      if (o.mode) patch.mode = o.mode as "autopilot" | "manual" | "paused";
      if (o["daily-target"]) patch.dailyTarget = Number(o["daily-target"]);
      if (o.budget) patch.dailyBudgetUsd = Number(o.budget);
      if (o.publish) patch.publishEnabled = o.publish === "on";
      await db.update(shows).set(patch).where(eq(shows.id, id));
      console.table(await db.select().from(shows).where(eq(shows.id, id)));
      break;
    }
    case "ideate": {
      const showId = o.show!;
      const job = await queue.enqueue(
        "ideation",
        {
          showId,
          count: Number(o.count ?? 10),
          autoStart: o["auto-start"] !== undefined ? Number(o["auto-start"]) : undefined,
          batchTag: o["batch-tag"],
        },
        { showId, priority: 50 },
      );
      console.log(`queued ideation job ${job?.id} — run: pnpm hermes run --until-idle`);
      break;
    }
    case "premises": {
      const [batch] = await db
        .select()
        .from(ideationBatches)
        .where(eq(ideationBatches.showId, o.show!))
        .orderBy(desc(ideationBatches.createdAt))
        .limit(1);
      if (!batch) return console.log("no batches yet");
      const rows = await db.select().from(premises).where(eq(premises.batchId, batch.id)).orderBy(asc(premises.rank));
      for (const p of rows)
        console.log(
          `\n#${p.rank} [${p.status}] ${p.id}\n  ${p.premise}\n  GAME: ${p.game}\n  BUTTON: ${p.button}\n  (${p.engine}, lead: ${p.leadCharacter})`,
        );
      break;
    }
    case "sketch:start": {
      const s = await startSketch(o.premise!, { batchTag: o["batch-tag"] });
      console.log(`sketch ${s.id} started at stage draft — run: pnpm hermes run --until-idle`);
      break;
    }
    case "run": {
      await runLoop({ untilIdle: o["until-idle"], concurrency: Number(o.concurrency ?? 3) });
      break;
    }
    case "resume": {
      const waiting = await db
        .select()
        .from(sketches)
        .where(and(eq(sketches.state, "in_progress"), inArray(sketches.stage, Object.keys(HANDLERS))));
      let n = 0;
      for (const s of waiting) if (await enqueueStage(s.id, s.showId, s.stage as SketchStage)) n++;
      console.log(`re-enqueued ${n} sketch stage(s)`);
      break;
    }
    case "jobs:retry": {
      await db
        .update(jobs)
        .set({ status: "queued", attempts: 0, runAfter: sql`now()`, lastError: null })
        .where(eq(jobs.id, Number(positionals[0])));
      console.log("requeued");
      break;
    }
    case "status": {
      const where = o.show ? eq(sketches.showId, o.show) : undefined;
      const rows = await db
        .select({ show: sketches.showId, state: sketches.state, stage: sketches.stage, n: sql<number>`count(*)::int` })
        .from(sketches)
        .where(where)
        .groupBy(sketches.showId, sketches.state, sketches.stage);
      console.log("SKETCHES");
      console.table(rows);
      console.log("QUEUES");
      console.table(await queue.queueDepth(["cpu", "gpu:tts", "gpu:render", "gpu:video"]));
      console.log(`spent today: ${usd(await spentToday(o.show))}`);
      console.log(
        `pipeline: ${SKETCH_STAGES.map((s) => (HANDLERS[s] ? s : `${s}*`)).join(" → ")}   (* = not built yet)`,
      );
      break;
    }
    case "sketch:show": {
      const id = positionals[0]!;
      const [s] = await db.select().from(sketches).where(eq(sketches.id, id));
      if (!s) return console.log("not found");
      const [ss] = await db
        .select()
        .from(shotScripts)
        .where(eq(shotScripts.sketchId, id))
        .orderBy(desc(shotScripts.createdAt))
        .limit(1);
      console.log(
        `${s.title ?? "(untitled)"} — ${s.state} @ ${s.stage} — ~${Math.round(s.runtimeS ?? 0)}s\n${s.logline ?? ""}\n`,
      );
      if (ss) console.log(renderText(ShotScript.parse(ss.data)));
      const costs = await db
        .select({
          stage: costLedger.stage,
          model: costLedger.model,
          usd: sql<number>`sum(${costLedger.usd})::float`,
          calls: sql<number>`count(*)::int`,
          out: sql<number>`sum(${costLedger.completionTokens})::int`,
          reasoning: sql<number>`sum(${costLedger.reasoningTokens})::int`,
        })
        .from(costLedger)
        .where(eq(costLedger.sketchId, id))
        .groupBy(costLedger.stage, costLedger.model);
      console.log("\nCOST");
      console.table(costs);
      console.log(`total: ${usd(s.costUsd)}`);
      break;
    }
    case "cost": {
      const where = o.show ? eq(costLedger.showId, o.show) : undefined;
      console.table(
        await db
          .select({
            stage: costLedger.stage,
            model: costLedger.model,
            calls: sql<number>`count(*)::int`,
            usd: sql<number>`sum(${costLedger.usd})::float`,
          })
          .from(costLedger)
          .where(where)
          .groupBy(costLedger.stage, costLedger.model),
      );
      console.log(`spent today: ${usd(await spentToday(o.show))}`);
      break;
    }
    default:
      console.log(HELP);
  }
}

try {
  await main();
} finally {
  await closeDb();
}
