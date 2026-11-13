import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { renderText, ShotScript } from "@hermes/agents";
import { closeDb, db, queue, salad, schema, spentToday, storage } from "@hermes/core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { runGpuDispatcher } from "./gpu.js";
import { approveDraft, getOrCreateDraft, judgeVoices, pickStyle, pickVoice } from "./kit.js";
import { enqueueStage, startSketch } from "./orchestrator.js";
import { SKETCH_STAGES, type SketchStage } from "./pipeline.js";
import { HANDLERS } from "./stages.js";
import { runLoop } from "./worker.js";

const { shows, showVersions, premises, sketches, shotScripts, jobs, costLedger, ideationBatches, artifacts } = schema;

const HELP = `hermes <command> [options]

Shows
  show:import <id> --from <dir> [--name "Name"]   import bible.md + kit.json as an approved version
  show:list
  show:set <id> [--mode autopilot|manual|paused] [--daily-target N] [--budget USD] [--publish on|off]

Show setup (art + voices)
  kit:start --show <id>                           Art Director brief + 3 style boards, Casting brief + voice auditions
  kit:assets --show <id> [--kind style_board]     list generated assets with view links
  kit:pick-style --show <id> --board <artifactId> pick a style board -> character sheets + backgrounds
  cast:pick --show <id> --take <artifactId>       pick a voice audition for its character
  show:approve <id>                               approve the draft version (sketches then use it)

Writing
  ideate --show <id> [--count 10] [--auto-start N] [--batch-tag T]   queue an ideation job
  premises --show <id>                            list the latest batch of premises
  sketch:start --premise <id> [--batch-tag T]     start a sketch from a premise

Running
  run [--until-idle] [--concurrency 3]            process CPU jobs (agents)
  gpu [--until-idle]                              dispatch GPU jobs (GPU_BACKEND=salad|local)
  infra:salad --image-repo <registry/user> [--tag T]   create Salad queues + scale-to-zero worker groups
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
    kind: { type: "string" },
    board: { type: "string" },
    take: { type: "string" },
    "image-repo": { type: "string" },
    apply: { type: "boolean" },
    tag: { type: "string" },
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
    case "kit:start": {
      const showId = o.show!;
      const draft = await getOrCreateDraft(showId);
      await queue.enqueue("kit:style_brief", { showId }, { showId, idempotencyKey: `${draft.id}:style_brief` });
      await queue.enqueue("cast:voice_brief", { showId }, { showId, idempotencyKey: `${draft.id}:voice_brief` });
      console.log(
        `draft v${draft.version}: queued Art Director + Casting. Run: pnpm hermes run --until-idle, then pnpm hermes gpu --until-idle`,
      );
      break;
    }
    case "kit:assets": {
      const rows = await db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.showId, o.show!), o.kind ? eq(artifacts.kind, o.kind) : undefined))
        .orderBy(asc(artifacts.kind), asc(artifacts.createdAt));
      for (const a of rows) {
        const m = a.meta as Record<string, unknown>;
        const label = [
          m.directionName,
          m.character,
          m.background,
          m.sheet,
          m.take ? `take ${m.take}` : null,
          m.seed ? `seed ${m.seed}` : null,
        ]
          .filter(Boolean)
          .join(" · ");
        console.log(`\n${a.kind}  ${a.id}\n  ${label}\n  ${await storage.presignGet(a.storageKey, 24 * 3600)}`);
      }
      if (!rows.length) console.log("no assets yet");
      break;
    }
    case "kit:pick-style": {
      const [a] = await db.select().from(artifacts).where(eq(artifacts.id, o.board!));
      if (a?.kind !== "style_board") throw new Error("--board must be a style_board artifact id");
      await pickStyle(o.show!, Number((a.meta as { direction: number }).direction), a.id, a.storageKey);
      console.log("style picked; character sheets + backgrounds queued. Run: pnpm hermes gpu --until-idle");
      break;
    }
    case "cast:pick": {
      const [a] = await db.select().from(artifacts).where(eq(artifacts.id, o.take!));
      if (a?.kind !== "voice_audition") throw new Error("--take must be a voice_audition artifact id");
      const character = (a.meta as { character: string }).character;
      await pickVoice(o.show!, character, a.id, a.storageKey);
      console.log(`${character}: voice picked`);
      break;
    }
    case "cast:judge": {
      const { results, best } = await judgeVoices(o.show!, Boolean(o.apply));
      for (const r of results.sort((a, b) => a.character.localeCompare(b.character) || a.take - b.take))
        console.log(
          `${r.character.padEnd(14)} take ${r.take}  overall ${r.score.overall}  brief ${r.score.matches_brief}  clarity ${r.score.clarity}  delivery ${r.score.comic_delivery}  clean ${r.score.artifacts}  — ${r.score.notes}`,
        );
      console.log(
        "\nBEST:",
        Object.values(best)
          .map((b) => `${b.character} take ${b.take}`)
          .join(", "),
        o.apply ? "(picked)" : "(use --apply to pick)",
      );
      break;
    }
    case "show:approve": {
      const v = await approveDraft(positionals[0]!, "cli");
      console.log(`approved v${v}; new sketches use it`);
      break;
    }
    case "infra:salad": {
      // Idempotent: creates missing Salad queues + scale-to-zero container groups for each GPU worker.
      const repo = o["image-repo"];
      const tag = o.tag ?? "latest";
      if (!repo) throw new Error("--image-repo is required, e.g. docker.io/<user> or ghcr.io/<user>");
      // GPU floors per pool, measured: FLUX.2 klein peaks at ~19 GB VRAM, and on Salad an over-full card
      // spills to system RAM (~100x slower) instead of failing, so the image pool needs 24 GB+ cards.
      const POOL_GPUS: Record<string, string[]> = {
        image: ["RTX 5090 (", "RTX 4090", "RTX 3090", "RTX A5000"],
        tts: [
          "RTX 5090 (",
          "RTX 4090",
          "RTX 3090",
          "RTX A5000",
          "RTX 4080 (",
          "RTX 4070 Ti Super",
          "RTX 4060 Ti (16",
          "RTX 5060 Ti (16",
        ],
      };
      const queues = new Set((await salad.listQueues()).items.map((q) => q.name));
      const groups = new Set((await salad.listContainerGroups()).items.map((g) => g.name));
      for (const pool of ["image", "tts"] as const) {
        const gpus = await salad.gpuClassIds(POOL_GPUS[pool]!);
        const image = `${repo}/hermes-${pool}:${tag}`;
        if (!queues.has(pool)) await salad.createQueue(pool, `Hermes ${pool} worker jobs`);
        const name = `hermes-${pool}`;
        if (!groups.has(name))
          await salad.createWorkerGroup({
            name,
            image,
            queue: pool,
            gpuClassIds: gpus,
            cpu: 8,
            memoryMb: 30720,
            storageGb: 60,
            maxReplicas: 2,
          });
        else await salad.updateWorkerGroup(name, image, gpus);
        console.log(
          `${pool}: ${groups.has(name) ? "updated" : "created"} ${name} -> ${image}, ${gpus.length} GPU classes`,
        );
      }
      break;
    }
    case "gpu": {
      await runGpuDispatcher({ untilIdle: o["until-idle"] });
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
