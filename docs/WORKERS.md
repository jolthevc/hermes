# GPU workers (SaladCloud)

## Shape

Each GPU capability is one Docker image, deployed as a **Salad container group** attached to a **Salad Job Queue**:

| Image           | Queue    | Does                                                                           |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `hermes-render` | `render` | Blender 5.2: scene assembly from the timeline, lip sync, render frames, encode |
| `hermes-tts`    | `tts`    | TTS takes per line + faster-whisper scoring                                    |
| `hermes-video`  | `video`  | LTX-2.x insert shots / style pass                                              |
| `hermes-image`  | `image`  | Qwen-Image / Qwen-Image-Edit art, LoRA training                                |

## Contract (identical for every worker)

1. **Dispatch.** The GPU dispatcher in `apps/brain` claims a job from our Postgres queue (`gpu:<name>`). It builds the job input:
   - presigned **GET** URLs for every input artifact
   - presigned **PUT** URLs for every expected output
   - stage params
2. **Submit.** It submits the input to the Salad Job Queue (`salad.submitJob`), then stores the Salad job id in `jobs.external_id`.
3. **Process.** Salad's job-queue worker inside the container `POST`s the input to the container's local HTTP endpoint, `POST /process`. The container:
   - downloads its inputs
   - does the work
   - uploads outputs to the PUT URLs
   - returns JSON: `{ outputs: [{ name, key, bytes, sha256, meta }], metrics: { gpu_seconds, ... } }`
4. **Collect.** The dispatcher polls (or receives a webhook for) the Salad job. On `succeeded` it:
   - registers the artifacts
   - records `gpu_seconds × rate` in the cost ledger
   - completes our job, which advances the sketch

   On `failed` it hands the error to the normal retry/remedy policy.

**Why this shape:** Salad nodes are community-hosted machines. They never receive database or storage credentials, only short-lived URLs scoped to one job's files.

## Scaling

The Brain sets replicas per container group from queue depth: 0 when idle, up to a per-queue max. Cold starts are minutes, so the Brain scales up ahead of each day's slate.

## To verify when building the images

- The container-group `queue_connection` fields (path/port).
- Job input size limits.
- Webhook signing.

Endpoints already verified against the Salad API reference: create-job path, `Salad-Api-Key` header, job statuses.

## Needed from you

`SALAD_ORG` and `SALAD_PROJECT` in `.env`. These are the organization and project names shown in the Salad portal URL.
