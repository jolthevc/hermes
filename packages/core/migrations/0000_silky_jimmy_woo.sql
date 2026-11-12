CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."show_mode" AS ENUM('autopilot', 'manual', 'paused');--> statement-breakpoint
CREATE TYPE "public"."show_status" AS ENUM('setup', 'live', 'archived');--> statement-breakpoint
CREATE TYPE "public"."sketch_state" AS ENUM('queued', 'in_progress', 'awaiting_review', 'approved', 'scheduled', 'published', 'parked', 'killed');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" text,
	"sketch_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer,
	"sha256" text,
	"parent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bandit_arms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" text NOT NULL,
	"dimension" text NOT NULL,
	"arm" text NOT NULL,
	"alpha" real DEFAULT 1 NOT NULL,
	"beta" real DEFAULT 1 NOT NULL,
	"pulls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"show_id" text,
	"sketch_id" uuid,
	"job_id" integer,
	"stage" text NOT NULL,
	"role" text,
	"provider" text NOT NULL,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"reasoning_tokens" integer,
	"cached_tokens" integer,
	"gpu_seconds" real,
	"usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideation_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" text NOT NULL,
	"show_version" integer NOT NULL,
	"requested" integer NOT NULL,
	"pitched_raw" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"error_class" text,
	"message" text NOT NULL,
	"sketch_id" uuid,
	"job_id" integer,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"error_class" text,
	"result" jsonb,
	"sketch_id" uuid,
	"show_id" text,
	"idempotency_key" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" text NOT NULL,
	"lesson" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metrics_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publication_id" uuid NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"age_hours" real NOT NULL,
	"views" integer,
	"avg_view_pct" real,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"saves" integer,
	"follows" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"role" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"fallbacks" text[] DEFAULT '{}'::text[] NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "premises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"show_id" text NOT NULL,
	"rank" integer NOT NULL,
	"premise" text NOT NULL,
	"game" text NOT NULL,
	"button" text NOT NULL,
	"engine" text,
	"lead_character" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sketch_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"external_id" text,
	"url" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sketch_id" uuid NOT NULL,
	"gate" text NOT NULL,
	"passed" boolean NOT NULL,
	"score" real,
	"defects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sketch_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"reviewer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sketch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"screenplay" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shot_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sketch_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "show_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" text NOT NULL,
	"version" integer NOT NULL,
	"bible" text NOT NULL,
	"kit" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"voices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"look" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "show_status" DEFAULT 'setup' NOT NULL,
	"mode" "show_mode" DEFAULT 'manual' NOT NULL,
	"publish_enabled" boolean DEFAULT false NOT NULL,
	"daily_target" integer DEFAULT 3 NOT NULL,
	"daily_budget_usd" numeric(12, 6) DEFAULT 5 NOT NULL,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sketches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"show_id" text NOT NULL,
	"show_version" integer NOT NULL,
	"premise_id" uuid,
	"state" "sketch_state" DEFAULT 'queued' NOT NULL,
	"stage" text NOT NULL,
	"title" text,
	"logline" text,
	"runtime_s" real,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"batch_tag" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"sketch_id" uuid,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"worker" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_class" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "bandit_arms" ADD CONSTRAINT "bandit_arms_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideation_batches" ADD CONSTRAINT "ideation_batches_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_sketch_id_sketches_id_fk" FOREIGN KEY ("sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_snapshots" ADD CONSTRAINT "metrics_snapshots_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "premises" ADD CONSTRAINT "premises_batch_id_ideation_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."ideation_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "premises" ADD CONSTRAINT "premises_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_sketch_id_sketches_id_fk" FOREIGN KEY ("sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_sketch_id_sketches_id_fk" FOREIGN KEY ("sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_sketch_id_sketches_id_fk" FOREIGN KEY ("sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_sketch_id_sketches_id_fk" FOREIGN KEY ("sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_scripts" ADD CONSTRAINT "shot_scripts_sketch_id_sketches_id_fk" FOREIGN KEY ("sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_versions" ADD CONSTRAINT "show_versions_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sketches" ADD CONSTRAINT "sketches_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sketches" ADD CONSTRAINT "sketches_premise_id_premises_id_fk" FOREIGN KEY ("premise_id") REFERENCES "public"."premises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_sketch" ON "artifacts" USING btree ("sketch_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "bandit_arm_unique" ON "bandit_arms" USING btree ("show_id","dimension","arm");--> statement-breakpoint
CREATE INDEX "cost_ledger_ts" ON "cost_ledger" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "cost_ledger_sketch" ON "cost_ledger" USING btree ("sketch_id");--> statement-breakpoint
CREATE INDEX "jobs_claim" ON "jobs" USING btree ("queue","status","priority","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "premises_show" ON "premises" USING btree ("show_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "show_versions_show_version" ON "show_versions" USING btree ("show_id","version");--> statement-breakpoint
CREATE INDEX "sketches_show_state" ON "sketches" USING btree ("show_id","state");--> statement-breakpoint
CREATE INDEX "stage_runs_sketch" ON "stage_runs" USING btree ("sketch_id");