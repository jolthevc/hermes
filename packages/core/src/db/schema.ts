import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const usd = (name: string) => numeric(name, { precision: 12, scale: 6, mode: "number" });

// ---------- shows ----------
export const showMode = pgEnum("show_mode", ["autopilot", "manual", "paused"]);
export const showStatus = pgEnum("show_status", ["setup", "live", "archived"]);

export const shows = pgTable("shows", {
  id: text("id").primaryKey(), // slug, e.g. "dragons-accountant"
  name: text("name").notNull(),
  status: showStatus("status").notNull().default("setup"),
  mode: showMode("mode").notNull().default("manual"),
  publishEnabled: boolean("publish_enabled").notNull().default(false),
  dailyTarget: integer("daily_target").notNull().default(3),
  dailyBudgetUsd: usd("daily_budget_usd").notNull().default(5),
  currentVersion: integer("current_version"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Frozen snapshot of a show's creative definition. Sketches pin the version they were made with.
export const showVersions = pgTable(
  "show_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: text("show_id")
      .notNull()
      .references(() => shows.id),
    version: integer("version").notNull(),
    bible: text("bible").notNull(),
    kit: jsonb("kit").notNull().default({}),
    voices: jsonb("voices").notNull().default({}),
    look: jsonb("look").notNull().default({}),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("show_versions_show_version").on(t.showId, t.version)],
);

// ---------- writing ----------
export const ideationBatches = pgTable("ideation_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  showId: text("show_id")
    .notNull()
    .references(() => shows.id),
  showVersion: integer("show_version").notNull(),
  requested: integer("requested").notNull(),
  pitchedRaw: text("pitched_raw"),
  createdAt: createdAt(),
});

export const premises = pgTable(
  "premises",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => ideationBatches.id),
    showId: text("show_id")
      .notNull()
      .references(() => shows.id),
    rank: integer("rank").notNull(),
    premise: text("premise").notNull(),
    game: text("game").notNull(),
    button: text("button").notNull(),
    engine: text("engine"),
    leadCharacter: text("lead_character"),
    status: text("status").notNull().default("proposed"), // proposed | picked | rejected | used
    createdAt: createdAt(),
  },
  (t) => [index("premises_show").on(t.showId, t.status)],
);

// ---------- sketches (state machine) ----------
export const sketchState = pgEnum("sketch_state", [
  "queued",
  "in_progress",
  "awaiting_review",
  "approved",
  "scheduled",
  "published",
  "parked", // needs Medic / human attention
  "killed",
]);

export const sketches = pgTable(
  "sketches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: text("show_id")
      .notNull()
      .references(() => shows.id),
    showVersion: integer("show_version").notNull(),
    premiseId: uuid("premise_id").references(() => premises.id),
    state: sketchState("state").notNull().default("queued"),
    stage: text("stage").notNull(), // current/next pipeline stage
    title: text("title"),
    logline: text("logline"),
    runtimeS: real("runtime_s"),
    features: jsonb("features").notNull().default({}),
    costUsd: usd("cost_usd").notNull().default(0),
    batchTag: text("batch_tag"), // e.g. "test-batch-2026-11-12"; batch sketches never auto-publish
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sketches_show_state").on(t.showId, t.state)],
);

export const scripts = pgTable("scripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  sketchId: uuid("sketch_id")
    .notNull()
    .references(() => sketches.id),
  kind: text("kind").notNull(), // draft | punchup | final
  screenplay: text("screenplay").notNull(),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const shotScripts = pgTable("shot_scripts", {
  id: uuid("id").primaryKey().defaultRandom(),
  sketchId: uuid("sketch_id")
    .notNull()
    .references(() => sketches.id),
  version: integer("version").notNull().default(1),
  data: jsonb("data").notNull(),
  createdAt: createdAt(),
});

// ---------- durable job queue ----------
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "dead", "cancelled"]);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    queue: text("queue").notNull(), // "cpu" | "gpu:render" | ...
    kind: text("kind").notNull(), // stage name
    payload: jsonb("payload").notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    errorClass: text("error_class"),
    result: jsonb("result"),
    sketchId: uuid("sketch_id").references(() => sketches.id),
    showId: text("show_id"),
    idempotencyKey: text("idempotency_key"),
    externalId: text("external_id"), // e.g. SaladCloud job id
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim").on(t.queue, t.status, t.priority, t.runAfter),
    uniqueIndex("jobs_idempotency").on(t.idempotencyKey),
  ],
);

// History of every attempt at every stage (for Medic, ops and cost per stage).
export const stageRuns = pgTable(
  "stage_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: integer("job_id").notNull(),
    sketchId: uuid("sketch_id"),
    stage: text("stage").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(), // succeeded | failed
    worker: text("worker"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorClass: text("error_class"),
    error: text("error"),
  },
  (t) => [index("stage_runs_sketch").on(t.sketchId)],
);

// ---------- artifacts ----------
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: text("show_id"),
    sketchId: uuid("sketch_id"),
    kind: text("kind").notNull(), // audio_take | frame | render | insert | final_cut | style_board | ...
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes"),
    sha256: text("sha256"),
    parentIds: uuid("parent_ids").array().notNull().default(sql`'{}'::uuid[]`),
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("artifacts_sketch").on(t.sketchId, t.kind)],
);

// ---------- cost + models ----------
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    showId: text("show_id"),
    sketchId: uuid("sketch_id"),
    jobId: integer("job_id"),
    stage: text("stage").notNull(),
    role: text("role"),
    provider: text("provider").notNull(), // openrouter | salad | ...
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedTokens: integer("cached_tokens"),
    gpuSeconds: real("gpu_seconds"),
    usd: usd("usd").notNull().default(0),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => [index("cost_ledger_ts").on(t.ts), index("cost_ledger_sketch").on(t.sketchId)],
);

export const modelRegistry = pgTable("model_registry", {
  role: text("role").primaryKey(),
  model: text("model").notNull(),
  fallbacks: text("fallbacks").array().notNull().default(sql`'{}'::text[]`),
  params: jsonb("params").notNull().default({}),
  updatedAt: updatedAt(),
});

// ---------- QA, review, publishing, learning, ops ----------
export const qaReports = pgTable("qa_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  sketchId: uuid("sketch_id")
    .notNull()
    .references(() => sketches.id),
  gate: text("gate").notNull(), // script | animatic | render
  passed: boolean("passed").notNull(),
  score: real("score"),
  defects: jsonb("defects").notNull().default([]),
  createdAt: createdAt(),
});

export const reviews = pgTable("reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  sketchId: uuid("sketch_id")
    .notNull()
    .references(() => sketches.id),
  decision: text("decision").notNull(), // approve | veto
  reason: text("reason"),
  reviewer: text("reviewer").notNull(),
  createdAt: createdAt(),
});

export const publications = pgTable("publications", {
  id: uuid("id").primaryKey().defaultRandom(),
  sketchId: uuid("sketch_id")
    .notNull()
    .references(() => sketches.id),
  platform: text("platform").notNull(), // youtube | instagram | tiktok
  status: text("status").notNull(), // scheduled | posted | failed
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  externalId: text("external_id"),
  url: text("url"),
  meta: jsonb("meta").notNull().default({}),
  createdAt: createdAt(),
});

export const metricsSnapshots = pgTable("metrics_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  publicationId: uuid("publication_id")
    .notNull()
    .references(() => publications.id),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  ageHours: real("age_hours").notNull(),
  views: integer("views"),
  avgViewPct: real("avg_view_pct"),
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  saves: integer("saves"),
  follows: integer("follows"),
  raw: jsonb("raw").notNull().default({}),
});

export const lessons = pgTable("lessons", {
  id: uuid("id").primaryKey().defaultRandom(),
  showId: text("show_id")
    .notNull()
    .references(() => shows.id),
  lesson: text("lesson").notNull(),
  evidence: jsonb("evidence").notNull().default({}),
  confidence: real("confidence"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const banditArms = pgTable(
  "bandit_arms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    showId: text("show_id")
      .notNull()
      .references(() => shows.id),
    dimension: text("dimension").notNull(), // engine | lead_character | format | hook
    arm: text("arm").notNull(),
    alpha: real("alpha").notNull().default(1),
    beta: real("beta").notNull().default(1),
    pulls: integer("pulls").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("bandit_arm_unique").on(t.showId, t.dimension, t.arm)],
);

export const incidents = pgTable("incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  severity: text("severity").notNull(), // info | warn | error | critical
  source: text("source").notNull(), // stage / agent / worker
  errorClass: text("error_class"),
  message: text("message").notNull(),
  sketchId: uuid("sketch_id"),
  jobId: integer("job_id"),
  context: jsonb("context").notNull().default({}),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolution: text("resolution"),
  createdAt: createdAt(),
});
