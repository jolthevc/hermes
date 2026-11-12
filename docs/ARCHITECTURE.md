# Hermes architecture

## 1. Design principles

1. **Deterministic spine, agentic nodes.** The pipeline is a durable state machine: every sketch moves through fixed stages, and each stage is retried, checkpointed and costed. Agents (LLMs and generative models) do the work _inside_ stages and make the decisions _between_ them. Free-roaming agents are not reliable enough to post unattended. A durable spine with smart nodes is.
2. **Every stage is idempotent.** Inputs are artifact ids and outputs are new artifacts, so any stage can be re-run, rerouted or replaced without touching the others. This is the basis for self-healing.
3. **Gates, not hope.** Quality is enforced at four gates: script, animatic, render and publish. A failed gate triggers a specific remedy, not a generic retry.
4. **The human is a gate, not a worker.** The human approves a show once (world, look, cast, voices), then picks or vetoes finished sketches. Their choices are the most valuable training signal the system gets.
5. **Learning is measured.** Every sketch carries its features (premise engine, cast, length, hook type, style). Outcomes feed bandits and a per-show memory. Nothing "learns" without a metric attached.
6. **The cheapest model that passes the gate.** A model registry maps each role to a model, with fallbacks. Cost is logged per call and capped per sketch, per show and per day.

## 2. Two pipelines

### A. Show creation: once per show, about 1 hour of human time

```
Concept brief (human, 1–2 lines, or "surprise me")
  → Showrunner: 3 world/cast/tone options → human picks
  → Showrunner: show bible (world, cast with wants/flaws/voices, sketch engines, never-do list)
  → Art Director: 3 style boards → human picks look
  → Art Director: character sheets (turnaround, 12 expressions, mouth set), backgrounds, props
  → Kit Builder: per-show style LoRA + puppet/rig per character (2D cutout, 3D toon or clay) + kit actions
  → Casting: 3 auditioned voices per character → human picks
  → Test reel: auto-generated 20s "screen test" (walk, talk, react) → QA + human approval
  → Show is live (manual or autopilot)
```

### B. Sketch production: daily, unattended

```
Brain (Executive Producer) plans today's slate per show (count, budget, explore/exploit mix)
  → Ideation: pitch 30 premises (show memory + bandit weights steer it)
  → Head Writer: pick N, de-duplicate against the show's history
  → Writer: draft  → Punch-up: revise
  → GATE 1 Script judge (ensemble calibrated to the human's picks): pass / revise once / kill
  → Script Editor: screenplay → shot script (beats, core/kit/insert actions)
  → Director: blocking, camera, timing, insert-shot prompts, SFX/music cues
  → Casting/Voice: TTS takes per line → pick takes by timing and ASR accuracy
  → Animatic: timed stills + audio → GATE 2 timing check (runtime, dead air, line overlaps)
  → Animator: Blender scene assembly + lip sync + render (on twos/threes per style)
  → Insert shots: video model from rig frames (only where the shot script asks)
  → Sound: SFX + music bed from the tagged library, loudness mix
  → Editor: assembly, captions, hook check (first 2s), trims
  → GATE 3 QA: technical checks + vision-model review → auto-fix loop (max 2) → pass/fail
  → GATE 4 Publish: autopilot + high confidence → schedule; otherwise → human review queue
  → Publisher: post with AI label, caption, hashtags at the scheduled slot
  → Analyst: metrics at 1h/24h/72h/7d → features × outcomes → show memory + bandits
```

## 3. The agents

| Agent                          | Job                                                                                                                                | Model (via OpenRouter unless noted)                                              | Tools                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Brain** (Executive Producer) | Plans the daily slate per show, allocates budget, watches pipeline health, decides retry/reroute/escalate, writes the daily report | Sonnet 5.5                                                                       | DB queries, queue control, cost ledger, model registry, GitHub issues |
| **Showrunner**                 | World and concept options, show bible, keeps the bible current from show memory                                                    | Opus 5.5                                                                         | Show memory, past bibles                                              |
| **Art Director**               | Style boards, character sheets, expressions, backgrounds, style LoRA training set                                                  | Qwen-Image / Qwen-Image-Edit-2511 (Apache-2.0) on GPU; Sonnet writes the prompts | Image workers, LoRA trainer                                           |
| **Kit Builder**                | Turns approved art into rigs: 2D cutout (layered parts on bones), 3D toon (image→3D→auto-rig) or clay; adds kit actions            | Sonnet 5.5 (writes `bpy`) + TRELLIS.2 (MIT) for 3D                               | Blender worker, segmentation                                          |
| **Casting**                    | Designs and auditions original voices; owns each character's voice reference                                                       | Open TTS (Chatterbox family, MIT) on GPU                                         | TTS worker                                                            |
| **Ideation**                   | Pitches premises steered by show memory and bandit weights                                                                         | Opus 5.5                                                                         | Show memory, history                                                  |
| **Head Writer**                | Picks premises; de-duplicates by embedding similarity                                                                              | Opus 5.5                                                                         | Embeddings, history                                                   |
| **Writer / Punch-up**          | Draft, then ruthless revision                                                                                                      | Opus 5.5                                                                         | none                                                                  |
| **Script Judge** (Gate 1)      | Scores scripts; calibrated against the human's picks and audience results                                                          | Ensemble: Opus + Sonnet, reweighted by measured agreement                        | none                                                                  |
| **Script Editor**              | Screenplay → shot script; maps actions to core/kit/insert                                                                          | Haiku 5.5                                                                        | Vocabulary, kit manifest                                              |
| **Director**                   | Blocking, camera, holds, insert-shot prompts, SFX cues                                                                             | Sonnet 5.5                                                                       | Kit manifest, shot templates                                          |
| **Voice**                      | TTS takes per line, picks the best by timing and ASR match                                                                         | Open TTS + faster-whisper (MIT)                                                  | TTS + ASR workers                                                     |
| **Animator**                   | Deterministic Blender assembly and render from the shot script                                                                     | none (code) + Rhubarb lip sync                                                   | Blender worker                                                        |
| **Insert Shot**                | Video-model inserts from rig frames + style LoRA; rerolls on QA fail                                                               | LTX-2.x (Community License, free under $10M revenue)                             | Video worker                                                          |
| **Sound Designer**             | Picks SFX and music from the tagged library, mixes to loudness target                                                              | Haiku 5.5 (tags/picks) + ffmpeg                                                  | Audio library                                                         |
| **Editor**                     | Final assembly, captions, hook check, trims dead air                                                                               | Sonnet 5.5 (decisions) + ffmpeg                                                  | Assembly worker                                                       |
| **QA** (Gate 3)                | Technical checks + watching the cut with a video-capable model; files fix tickets for a specific stage                             | Code + Gemini (video input)                                                      | ASR, frame tools                                                      |
| **Medic**                      | Self-healing: classifies failures, applies remedies, escalates novel ones                                                          | Sonnet 5.5                                                                       | Logs, remedy playbook, queue, GitHub                                  |
| **Publisher**                  | Captions, hashtags, timing, AI labels, posting                                                                                     | Haiku 5.5 + platform APIs                                                        | Publishing APIs                                                       |
| **Analyst**                    | Ingests metrics, writes post-mortems, updates show memory and bandits, proposes experiments                                        | Sonnet 5.5                                                                       | Metrics DB, stats                                                     |

## 4. Self-healing: three levels

1. **Stage remedies (automatic, seconds).** Every stage has a remedy playbook keyed by error class:
   - Transient errors: retry with backoff.
   - Out of memory: lower the batch or resolution.
   - Model refusal or bad output: re-prompt, then fall back to an alternate model.
   - Render crash: re-run on another worker.
   - QA defect: re-run only the offending stage (one shot, one take).
   - Each stage gets at most 2 auto-fixes, then the sketch is parked.
2. **Medic agent (minutes).** Parked sketches and repeated failure classes go to the Medic. It reads logs and artifacts, picks a remedy (reroute, regenerate upstream, adjust the shot script) or kills the sketch with a reason. It also watches for systemic issues (a worker pool failing, a model degrading, cost drifting) and tells the Brain to throttle or reroute.
3. **Engineering loop (hours).** Novel failure classes become GitHub issues with a reproduction (artifact ids plus logs). A headless Claude Code run attempts a fix on a branch, runs the canary sketch, and opens a PR. **A human merges.** Agents never deploy their own code changes.

Supporting pieces:

- **Canary sketch:** a fixed sketch rendered on every deploy and nightly, diffed against last-known-good on cost, runtime and QA scores.
- **Circuit breakers:** a stage error rate above threshold pauses that stage and alerts. Production continues where possible.
- **Budget guards:** hard caps per sketch, per show per day, and globally. They pause rather than overspend.

## 5. Self-learning

- **Features per sketch:** premise engine (escalation, status game, literal-minded, procedural…), lead character, cast size, runtime, hook type, ending type, number of inserts, style, posting slot.
- **Outcome metric:** retention-weighted engagement, normalized to the account's baseline. Platforms differ, so it's computed per platform:
  - Completion rate and average view duration
  - Shares and saves per view
  - Comments per view
  - Follows per view
- **Bandits:** Thompson sampling over premise engines, characters and formats per show. About 80% exploit, 20% explore, set by the Brain.
- **Show memory:** the Analyst writes post-mortems on top and bottom performers into `lessons` ("Ember losing status beats Ember winning"). Ideation and the Showrunner read it, and the bible evolves with each version.
- **Judge calibration:** human picks/vetoes plus audience outcomes become preference pairs, used to reweight the Gate 1 ensemble and, later, train a small reward model. We track the judge's correlation with outcomes over time.
- **Prompt evolution:** A/B variants of agent prompts on a slice of production, promoted only on significant wins.
- **Our own winners become examples:** our top-performing sketches become few-shot examples for their own show. Reference channels' material never does.

## 6. Tech stack

| Layer            | Choice                                                                                                                   | Why                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Control plane    | TypeScript, Node 22 (ESM), zod                                                                                           | Already in use; typed agent I/O                                      |
| Database         | Postgres (Neon or Supabase)                                                                                              | Source of truth: shows, sketches, stages, artifacts, costs, metrics  |
| Durable jobs     | Postgres-backed queue (pg-boss) + per-sketch state machine                                                               | Durable, inspectable, no extra infra; can move to Temporal if needed |
| Artifact storage | Cloudflare R2                                                                                                            | S3-compatible, no egress fees for video                              |
| LLMs             | Claude Opus/Sonnet/Haiku 5.5 via OpenRouter + one model registry                                                         | One key, one bill; per-role fallbacks                                |
| Vision/video QA  | Gemini with video input via OpenRouter                                                                                   | Watches finished cuts like a reviewer                                |
| GPU workers      | Python Docker images on SaladCloud (batch queue) + RunPod (on-demand)                                                    | Cheap consumer GPUs; workers pull jobs                               |
| Rendering        | Blender 5.2 headless: 2D cutout (image planes + bones), Grease Pencil for line effects, EEVEE toon, clay shading on twos | One renderer, every style, fully scriptable                          |
| Image gen        | Qwen-Image / Qwen-Image-Edit-2511 + per-show LoRA                                                                        | Apache-2.0, strong character consistency                             |
| 3D gen           | TRELLIS.2 (MIT; use a native integration without NVIDIA's research-only libraries)                                       | Commercial-safe image→3D                                             |
| TTS              | Chatterbox family (MIT), other open models as fallback                                                                   | Emotion control, cloning from our own designed voices                |
| Lip sync         | Rhubarb (2D mouth sets); visemes → shape keys (3D)                                                                       | Deterministic                                                        |
| Video inserts    | LTX-2.x distilled (free under $10M revenue; AI-label clause)                                                             | Seconds per clip                                                     |
| ASR              | faster-whisper (MIT)                                                                                                     | Captions, take selection, QA                                         |
| Assembly         | ffmpeg                                                                                                                   | Captions, mixing, loudness, encode                                   |
| Dashboard        | Next.js                                                                                                                  | Show setup approvals, review queue, toggles, cost and metrics        |
| Publishing       | YouTube Data API direct; Instagram/TikTok via an aggregator (e.g. Upload-Post) until our own app audits clear            | TikTok and Meta app reviews take days to weeks                       |
| Observability    | Cost ledger + Langfuse (self-host) for LLM traces                                                                        | Per-sketch cost and debugging                                        |
| Build agents     | Claude Code (sessions per workstream; headless for the engineering loop)                                                 | How Hermes builds and repairs itself                                 |

## 7. Data model (core tables)

- **Shows and assets:** `shows`, `show_versions` (bible, kit and voice refs, frozen per version), `characters`, `voices`, `kits`, `kit_actions`
- **Writing:** `premises`, `scripts`, `shot_scripts`
- **Production:** `sketches` (state machine), `stage_runs` (stage, attempt, status, error class, cost, duration, worker), `artifacts` (R2 key, type, hash, parent ids)
- **Review and publishing:** `qa_reports`, `reviews` (human pick/veto + reason), `publications`
- **Learning:** `metrics_snapshots`, `lessons`, `bandit_arms`
- **Infrastructure:** `model_registry`, `cost_ledger`, `incidents`

## 8. Controls (dashboard)

- **Per show:**
  - Mode: `autopilot` | `manual` | `paused`
  - Daily target count and budget cap
  - Publishing on/off, independent of production
  - "Make a batch of N now", for testing; never auto-published
- **Global:** kill switch, model registry editor, cost and incident views.
- **Review feed:** swipe approve/veto with an optional one-tap reason (not funny, off-model, glitch, timing, too long). Each reason feeds learning.

## 9. Cost per sketch (estimates, to be measured)

| Stage                                         | Estimate         |
| --------------------------------------------- | ---------------- |
| Writing (pitch/pick share + draft + punch-up) | $0.22 (measured) |
| Shot script + direction                       | $0.01–0.03       |
| TTS takes + ASR                               | $0.01–0.02 (GPU) |
| Render (Blender, GPU)                         | $0.02–0.10       |
| Insert shots (0–3)                            | $0.00–0.05       |
| QA (video model + checks)                     | $0.01–0.04       |
| **Total**                                     | **≈ $0.30–0.45** |

## 10. Repo layout (target)

```
apps/dashboard        Next.js control room
apps/brain            orchestrator service: state machine, Brain + Medic agents, schedulers
packages/core         zod schemas, db, model registry, cost ledger, R2 client
packages/agents       one module per agent (prompts + I/O schemas + tests)
workers/render        Blender 5.2 image: scene assembly, lip sync, render
workers/tts           TTS + take selection
workers/video         LTX inserts
workers/image         Qwen-Image + LoRA training
workers/asr           faster-whisper
workers/assemble      ffmpeg edit, captions, mix
shows/<id>/           bible.md, kit manifest, voice refs (assets live in R2)
writing-test/, render-test/   experiments
docs/
```

## 11. Known risks

| Risk                                                                                                                                         | Mitigation                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Comedy quality: a beautiful but unfunny sketch is a failure                                                                                  | Gate 1 judges calibrated to your picks; the learning loop; writing refined in parallel                                        |
| Auto-building rigs from generated art (layered parts, occluded regions) is the hardest automation                                            | Per-archetype rig templates; generate parts separately rather than segmenting one image; human approves the kit once per show |
| Headless GPU rendering in containers (graphics libraries)                                                                                    | `render-test` kit; choose a GPU provider that exposes graphics capabilities                                                   |
| Platform access: TikTok audit, Meta app review, YouTube upload quota (default ~6 uploads/day per API project; increase needs an application) | Apply on Day 1; use an aggregator meanwhile                                                                                   |
| Repetitive or mass-produced content flags (YouTube inauthentic-content policy)                                                               | Distinct shows with real points of view; de-duplication; cap daily volume per channel                                         |
| LTX remote-restriction clause                                                                                                                | Inserts are optional; Wan as a fallback                                                                                       |
