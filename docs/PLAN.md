# Hermes execution plan (frames-first)

What we're building toward, in order. Supersedes `SPRINT.md` (written for the puppet/Blender approach; see `DECISIONS.md`, 2026-11-13).

## The goal

An autonomous studio that publishes good short animated comedy sketches (under 60s, 9:16) for many shows at once, at well under $1 per sketch, with about 1% human effort: approve a show once, then pick or veto finished sketches. The pipeline is the same agentic system as before; only the production step changed.

## The pipeline

Stages 1–3 are already built; stages 4–11 are new or changed.

```
 1 Ideation + Head Writer   pitch 30, pick N                    (built)
 2 Writer + Punch-up        draft, revise                       (built)
 3 Script Editor            screenplay -> shot script (beats)   (built)
 4 Script Gate              judge ensemble: pass / revise / kill
 5 Director                 beats -> shot list: type, framing, characters, keyframe prompt,
                            motion prompt, duration, which line plays
 6 Voice                    TTS per line from each character's approved voice (+ word timings)
 7 Animatic Gate            timings vs shot list: runtime, dead air, overlaps
 8 Keyframes                one still per shot from model sheet + background refs; vision judge; reroll
 9 Animate                  talk = audio-driven video | react/hold = near-still i2v or held frame |
                            action = first(/last)-frame i2v
10 Edit                     cut to timing, holds, captions, SFX/music bed, loudness
11 QA Gate                  video judge per shot + whole cut; reroll a shot, never the sketch
12 Review / Publish         autopilot or human feed; AI labels; schedule
13 Analyst                  metrics -> show memory + bandits
```

Every stage is a durable job (retries, cost ledger, caps). GPU stages dispatch to Vast first and RunPod as fallback.

## Milestones

### M1: Canary sketch end to end (now)

Render "Seventy-Four" (The Dragon's Accountant) through stages 5–10 with the frames-first stack.

- **Director agent** produces the shot list (schema-validated).
- **Voice** generates lines with the approved voices: Ember take 2, Dunmore take 3, and Grimsby's best take for now.
- **Keyframes** are made with FLUX.2 klein from model sheets and plates, and judged.
- **hermes-video worker** has one talking-video model and one image-to-video model (choice from the research in progress).
- **Assembly** in ffmpeg: shots on the audio timeline plus burned-in captions.
- **Done when:**
  - an MP4 exists that you've watched
  - cost per stage is measured
  - reroll counts are known
  - you've given a verdict: postable / close / no

### M2: Quality gates + self-healing

- Script Gate (judge ensemble calibrated on your picks), Animatic Gate, video QA with per-shot reroll, and the Medic (failure classes → remedies → escalation).
- Grimsby voice bake-off: short accent-first prompt, built-in speakers, Parler-TTS.
- Canary runs on every deploy.
- **Done when:** 5 sketches go through stages 1–11 unattended, with a QA report on each.

### M3: Autopilot + control room

- **Brain:** daily slate per show, budget guards, health watch, daily report.
- **Dashboard:**
  - review feed with approve/veto and reasons
  - per show: autopilot/manual/paused, publishing on/off, batch-of-N
  - cost and incident views
- **Done when:** a batch of 10 can run from the dashboard and be reviewed on a phone.

### M4: Publishing + learning

- YouTube Shorts direct; Instagram/TikTok through an aggregator until our app audits clear; AI labels.
- Analyst ingests metrics at 1h/24h/72h/7d, keeps a features table and bandits, and writes post-mortems into show memory.
- **Done when:** approved sketches post on schedule and metrics flow back.

### M5: Second show

- Run show creation end to end (Showrunner → Art Director → Casting) for a new show in a different style. Time it and cost it.
- **Done when:** a new show produces its first postable sketch with under an hour of your time.

### M6: Hardening

- A 24-hour unattended run across 2 shows.
- Fix the top failure classes.
- Nightly canary, circuit breakers, kill switch.
- **Done when:** under $1 per sketch is measured, there are no unhandled failures in 24h, and your time is a few minutes per day.

## Standing targets

| Metric                                   | Target                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| Cost per finished sketch                 | < $1 (expected about $0.50: writing about $0.23 + production) |
| Human time per show per day              | a few minutes (review feed)                                   |
| Shot reroll rate                         | measure in M1, then drive down                                |
| Sketch-level QA pass before human review | > 80% by M6                                                   |

## Not in scope yet

- Direct Instagram/TikTok APIs (waiting on platform reviews).
- Learning that's meaningful (needs weeks of posts).
- Pixel-identical characters (frames-first is very close, not identical; see `DECISIONS.md`).
