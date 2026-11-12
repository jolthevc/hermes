# Hermes

Hermes is an autonomous studio that makes short animated comedy sketches (under 60s, 9:16) for Instagram Reels, TikTok and YouTube Shorts. It runs many "shows" at once. Each show has its own world, cast, art style and voices. A human approves each show once (world, look, cast, voices), then only picks or vetoes finished sketches. Everything else is done by agents.

Read `docs/ARCHITECTURE.md` for the system design and `docs/SPRINT.md` for the current build plan.

## Non-negotiable rules

- **Originality.** All characters, worlds and styles are our own. Never imitate a specific existing show's characters or look. Never clone a real person's voice.
- **Gold references are for measurement only.** Transcribed reference sketches (`writing-test/gold/`) are used only to rate output. They never go into prompts, few-shot examples, fine-tuning data or anything published.
- **Track the cost of every model call** (tokens and USD) in the cost ledger, tagged by show, sketch and stage. Cost per sketch must stay well under $1. Every runner enforces a spending cap.
- **Model calls go through OpenRouter** (Claude included) unless the user says otherwise. Model ids live in one registry, not scattered through the code.
- **Secrets live in `.env`** (git-ignored). Never commit keys, print them or put them in URLs.
- **Openly AI-made.** Published posts carry the platforms' AI-content labels.
- **Nothing publishes without passing the QA gates.** A show on autopilot can auto-publish only when every gate passes with high confidence. Otherwise sketches go to the human review queue.

## Repo map

- `packages/core/`: env (zod), Postgres schema + migrations (drizzle), durable job queue (`jobs.ts`, SKIP LOCKED + leases), cost ledger + budget caps, model registry, OpenRouter client with fallbacks, S3/R2 storage, SaladCloud client
- `packages/agents/`: agent prompts + I/O schemas (writers' room today; the shot-script schema is the production contract)
- `apps/brain/`: orchestrator: pipeline stages (`pipeline.ts`), stage handlers (`stages.ts`), worker loop, `hermes` CLI
- `docs/`: architecture, sprint plan, GPU worker contract (`WORKERS.md`)
- `writing-test/`, `render-test/`: early experiments (writing harness, Blender headless GPU test)

## Commands

- `pnpm install`; `pnpm check` (typecheck + lint + test); `pnpm format`
- After schema changes: `pnpm db:generate`, then `pnpm db:migrate`
- `pnpm hermes` with no args lists CLI commands. Typical: `ideate --show <id> --count 10 --auto-start 1`, `run --until-idle`, `status`, `sketch:show <id>`
- Adding a pipeline stage: write a handler in `apps/brain/src/stages.ts`, register it in `HANDLERS`, then run `pnpm hermes resume` to pick up waiting sketches

## Conventions

- **TypeScript (Node 22, ESM)** for the control plane and agents. **Python** for GPU workers (Blender `bpy`, TTS, video, image, ASR).
- **Stages are idempotent and resumable.** Each takes inputs by artifact id and writes new artifacts. It never mutates an earlier stage's output.
- **Structured data between agents** uses zod schemas and JSON-schema structured output, validated at every boundary.
- **Shot scripts are renderer-agnostic:** a shared core vocabulary plus per-show kit actions, with video-model insert shots as the fallback. The vocabulary never limits what writers can write.
- **Prefer open-weight models on rented GPUs** where quality allows. Check licenses before adopting a model and record them in `docs/MODELS.md`.
- **Keep changes small and verify by running.** For pipeline changes, run the canary sketch end to end before calling it done.
