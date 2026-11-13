#!/usr/bin/env bash
# One image, three ways to run:
#   RunPod Serverless (RUNPOD_ENDPOINT_ID set): pull jobs from RunPod's queue via the runpod SDK
#   SaladCloud (SALAD_MACHINE_ID set): HTTP app + Salad's job-queue worker
#   Anywhere else (Vast.ai instances, local mock): HTTP app on $PORT, jobs POSTed to /process with a token
set -euo pipefail
PORT="${PORT:-8000}"

if [[ -n "${RUNPOD_ENDPOINT_ID:-}" ]]; then
  exec python -m hermes_worker.runpod_entry
fi

uvicorn hermes_worker.server:app --host 0.0.0.0 --port "$PORT" --workers 1 &

until (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; do sleep 1; done

if [[ -n "${SALAD_MACHINE_ID:-}" && -x /usr/local/bin/salad-http-job-queue-worker ]]; then
  # Keep Salad worker logs at error level: info/debug would log job inputs (presigned URLs).
  export SALAD_LOG_LEVEL="${SALAD_LOG_LEVEL:-error}"
  /usr/local/bin/salad-http-job-queue-worker &
fi

wait -n
exit $?
