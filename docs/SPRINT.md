# 7-day sprint: Hermes v1

## Goal by Day 7
**One show, The Dragon's Accountant, runs unattended end to end.** It:
- Writes and produces sketches automatically.
- QA-gates them and puts them in a review feed.
- Publishes approved sketches to YouTube Shorts.
- Records the cost of every sketch.
- Pulls back metrics.

**A second show is spun up in a different style (3D toon or clay),** to prove new shows are cheap.

**Out of scope for 7 days** (because of external dependencies, not effort):
- Direct Instagram/TikTok APIs, which are waiting on Meta review and the TikTok audit. Use an aggregator, or post manually from the review feed.
- Learning from real audience data. That needs weeks of posts, so the loop is built and fed but not yet meaningful.
- Dozens of shows.

## Day 0 (today): admin, started now because these have waiting periods
- [ ] **TikTok:** create a developer app and apply for the Content Posting API audit.
- [ ] **Meta:** create a developer app, connect an Instagram Business account to a Facebook Page, and start business verification.
- [ ] **YouTube:**
  - Set up a Google Cloud project with the YouTube Data API.
  - Run OAuth on the target channel.
  - Request a quota increase (the default allows about 6 uploads a day).
- [ ] **Accounts:** Neon (Postgres), Cloudflare R2, and either RunPod or SaladCloud with graphics-capable GPUs.
- [ ] **Render test:** run `render-test` on a GPU and send back `summary.txt` and `report.json`.

## Day 1: foundation
- Monorepo scaffold (`apps/`, `packages/`, `workers/`), CI with lint, typecheck and tests.
- `packages/core`:
  - Postgres schema and migrations (tables in ARCHITECTURE §7)
  - Model registry
  - Cost ledger, ported from `writing-test`
  - R2 client
  - zod schemas: Sketch, ShotScript, KitManifest
- Durable queue (pg-boss) and the sketch state machine with stage retries.
- Port the writers' room (`writing-test`) into `packages/agents`: ideation, head writer, writer, punch-up, script editor.
- **Done when:** `hermes sketch new --show dragons-accountant` produces a stored shot script with the cost recorded in Postgres.

## Day 2: show kit (art + voices) for The Dragon's Accountant
- **Image worker** (Qwen-Image-Edit-2511):
  - Style boards (you pick one)
  - Character sheets: Grimsby, Dunmore, and Ember's parts (eye, claw, tail, wing, flank)
  - Expressions and mouth sets
  - The cave background and props
- **Kit Builder:** a 2D cutout rig template per archetype (biped, "giant partial") in Blender. Parts are generated separately, then layered and parented to bones.
- **Casting:** 3 designed voices per character, auditioned (you pick).
- **Done when:** an approved kit manifest exists, and a 10-second screen test renders, walk/talk/react.

## Day 3: first sketch rendered end to end
- **Director agent:** shot script → timeline (camera, blocking, holds).
- **Voice worker:** takes per line, then picks the best by timing and ASR match.
- **Render worker:** Blender scene assembly from the timeline + Rhubarb lip sync + render at 1080×1920.
- **Assemble worker:** ffmpeg mix, captions, loudness normalization.
- **Canary sketch:** "Schedule G" (premise #7).
- **Done when:** a finished MP4 of Schedule G exists, with a measured cost per stage.

## Day 4: QA gates and inserts
- **Technical QA:**
  - Duration
  - Loudness (LUFS)
  - Black or frozen frames
  - ASR error rate against the script
  - Lip-sync offset
  - Missing assets
- **Video-model QA:** Gemini reviews the cut and outputs structured defects, each pointing at a shot and stage.
- **Auto-fix loop:** re-run only the offending stage, at most 2 times.
- **Insert worker (LTX-2.x):** run hybrid tests (a) and (b). Measure warp-error flicker, identity drift and cost, and decide whether inserts and the style pass ship.
- **Sound:** tagged SFX/music library, and the Sound Designer agent.
- **Done when:** 5 sketches go through Gates 1–3 unattended, with a QA report each.

## Day 5: Brain, Medic and dashboard
- **Brain:** daily slate planner, budget guards, health watch, daily report.
- **Medic:** error classification, remedy playbook, escalation to GitHub issues.
- **Dashboard (Next.js):**
  - Show setup approvals
  - Review feed (approve/veto + reasons)
  - Per-show autopilot/manual/paused toggle, publishing toggle, batch-of-N button
  - Cost and incident views
- **Done when:** you can run a batch of 10 from the dashboard and review it on your phone.

## Day 6: publishing, analytics, second show
- **Publisher:** YouTube Shorts direct; aggregator for Instagram/TikTok. Captions, hashtags, AI labels, scheduled slots.
- **Analyst:** metrics ingestion at 1h/24h/72h/7d, features table, bandit arms, post-mortem writer, show memory.
- **Second show:** run the full show-creation pipeline (Showrunner → Art Director → Kit Builder → Casting) for a show in 3D toon or clay style. Time it and cost it.
- **Done when:** the first approved sketch is posted on YouTube Shorts, and show #2 has an approved kit.

## Day 7: hardening and go-live
- **Unattended batch:** 24 hours on autopilot to the review queue (about 20 sketches across 2 shows).
- **Fix the top failure classes**, and add the remedies to the playbook.
- **Ops:** canary on deploy and nightly; circuit breakers; global kill switch.
- **Reports:** cost per sketch by stage, QA pass rate, your approval rate, time you spent per day.
- **Done when:**
  - Under 1% human effort: a few minutes a day reviewing.
  - Under $1 per sketch, measured.
  - No unhandled failures in 24 hours.

## How we build it in 7 days
- **Parallel Claude Code sessions per workstream,** each in its own git worktree and branch:
  - (A) core + orchestration
  - (B) agents
  - (C) GPU workers
  - (D) dashboard + publishing
- **You** handle Day 0 admin, approve the kit and voices (Day 2), and review the canary (Day 3).
- **Every workstream ends each day** with a green canary run and a short written status in `docs/STATUS.md`.
