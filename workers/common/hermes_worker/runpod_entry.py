"""RunPod Serverless entrypoint: same job contract as the HTTP server (docs/WORKERS.md).

RunPod delivers {"input": <JobInput>} from its queue; the handler's return value becomes the job output.
"""

from __future__ import annotations

import runpod

from hermes_worker.server import JobInput, init, run_job


def handler(job: dict) -> dict:
    return run_job(JobInput(**job["input"]))


if __name__ == "__main__":
    init()  # load models once per worker, before taking jobs
    runpod.serverless.start({"handler": handler})
