#!/usr/bin/env bash
# Starts the worker HTTP app, waits for the port, then (on SaladCloud only) starts Salad's job-queue worker.
set -euo pipefail
PORT="${PORT:-8000}"

uvicorn hermes_worker.server:app --host 0.0.0.0 --port "$PORT" --workers 1 &
APP_PID=$!

until (echo > "/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; do sleep 1; done

if [[ -n "${SALAD_MACHINE_ID:-}" && -x /usr/local/bin/salad-http-job-queue-worker ]]; then
  # Keep Salad worker logs at error level: info/debug would log job inputs (presigned URLs).
  export SALAD_LOG_LEVEL="${SALAD_LOG_LEVEL:-error}"
  /usr/local/bin/salad-http-job-queue-worker &
fi

wait -n
exit $?
