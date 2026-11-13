CREATE TABLE "gpu_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"pool" text NOT NULL,
	"provider_id" text NOT NULL,
	"status" text NOT NULL,
	"url" text,
	"token" text NOT NULL,
	"image" text NOT NULL,
	"dph" real,
	"gpu_name" text,
	"machine_id" text,
	"busy_job_id" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"destroyed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "infra_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gpu_instances_pool_status" ON "gpu_instances" USING btree ("pool","status");