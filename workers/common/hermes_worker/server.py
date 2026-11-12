"""Shared HTTP worker for all Hermes GPU images.

Contract (docs/WORKERS.md): Salad's job-queue worker POSTs the job input to /process.
Input:  {"task": str, "params": {...}, "inputs": {name: GET-url}, "outputs": {name: {"url": PUT-url, "content_type": str}}}
Output: {"ok": true, "outputs": [{"name", "bytes", "sha256", "meta"}], "metrics": {"gpu_seconds", ...}}
Nodes never hold DB/storage credentials: they only see presigned URLs scoped to this job.
"""

from __future__ import annotations

import hashlib
import importlib
import logging
import os
import time
import traceback
from typing import Any, Callable

import requests
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

log = logging.getLogger("hermes-worker")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

MOCK = os.environ.get("HERMES_MOCK") == "1"


class OutputSpec(BaseModel):
    url: str
    content_type: str


class JobInput(BaseModel):
    task: str
    params: dict[str, Any] = Field(default_factory=dict)
    inputs: dict[str, str] = Field(default_factory=dict)
    outputs: dict[str, OutputSpec] = Field(default_factory=dict)


class Ctx:
    """What a task handler gets: downloaded inputs and a way to write outputs."""

    def __init__(self, job: JobInput):
        self.job = job
        self.params = job.params
        self._written: list[dict[str, Any]] = []

    def input_bytes(self, name: str) -> bytes:
        url = self.job.inputs[name]
        r = requests.get(url, timeout=300)
        r.raise_for_status()
        return r.content

    def write(self, name: str, data: bytes, meta: dict[str, Any] | None = None) -> None:
        spec = self.job.outputs.get(name)
        if spec is None:
            raise KeyError(f"no output slot named {name!r}; slots: {list(self.job.outputs)}")
        r = requests.put(spec.url, data=data, headers={"Content-Type": spec.content_type}, timeout=600)
        r.raise_for_status()
        self._written.append(
            {"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "meta": meta or {}}
        )


Handler = Callable[[Ctx], dict[str, Any] | None]


def load_handlers() -> dict[str, Handler]:
    module = importlib.import_module(os.environ.get("HERMES_HANDLER_MODULE", "handler"))
    return getattr(module, "TASKS")


app = FastAPI()
TASKS: dict[str, Handler] = {}
READY = False


@app.on_event("startup")
def _startup() -> None:
    global TASKS, READY
    TASKS = load_handlers()
    warm = getattr(importlib.import_module(os.environ.get("HERMES_HANDLER_MODULE", "handler")), "warmup", None)
    if warm and not MOCK:
        t = time.time()
        warm()
        log.info("models loaded in %.1fs", time.time() - t)
    READY = True


@app.get("/health")
def health() -> JSONResponse:
    # Used as the Salad readiness probe: the job-queue worker waits for this before pulling jobs.
    return JSONResponse({"ready": READY, "mock": MOCK}, status_code=200 if READY else 503)


@app.post("/process")
def process(job: JobInput) -> JSONResponse:
    handler = TASKS.get(job.task)
    if handler is None:
        return JSONResponse({"ok": False, "error": f"unknown task {job.task}", "error_class": "fatal"}, status_code=400)
    ctx = Ctx(job)
    started = time.time()
    try:
        metrics = handler(ctx) or {}
    except Exception as e:  # noqa: BLE001 - surfaced to the orchestrator for classification
        log.error("task %s failed: %s", job.task, e)
        # 200 with ok=false: a deterministic failure should not burn Salad's 4 automatic retries;
        # the orchestrator applies its own retry policy by error class.
        return JSONResponse(
            {"ok": False, "error": str(e)[:2000], "trace": traceback.format_exc()[-4000:], "error_class": "fatal"}
        )
    metrics.setdefault("gpu_seconds", round(time.time() - started, 3))
    return JSONResponse({"ok": True, "outputs": ctx._written, "metrics": metrics})
