# One Dockerfile for every Hermes GPU worker.
#   docker build -f workers/Dockerfile --build-arg WORKER=image -t ghcr.io/jolthevc/hermes-image:<tag> workers
#   docker build -f workers/Dockerfile --build-arg WORKER=tts   -t ghcr.io/jolthevc/hermes-tts:<tag>   workers
# Mock build (no CUDA, for contract tests):  --build-arg BASE=python:3.11-slim --build-arg MOCK=1
ARG BASE=pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime
FROM ${BASE}

ARG WORKER
ARG MOCK=0
ARG SALAD_WORKER_VERSION=v0.7.0

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HF_HOME=/models PORT=8000 \
    HERMES_HANDLER_MODULE=handler HERMES_MOCK=${MOCK}

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg libsndfile1 git \
    && rm -rf /var/lib/apt/lists/*

# Salad job-queue worker (only started on SaladCloud; see common/start.sh)
RUN curl -fsSL "https://github.com/SaladTechnologies/salad-cloud-job-queue-worker/releases/download/${SALAD_WORKER_VERSION}/salad-http-job-queue-worker_x86_64.tar.gz" \
    | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/salad-http-job-queue-worker

WORKDIR /app
COPY common/requirements.txt /app/common-requirements.txt
RUN pip install -r /app/common-requirements.txt
COPY ${WORKER}/requirements.txt /app/requirements.txt
RUN if [ "$MOCK" != "1" ]; then pip install -r /app/requirements.txt; fi

COPY common/hermes_worker /app/hermes_worker
COPY common/start.sh /app/start.sh
COPY ${WORKER}/handler.py /app/handler.py
RUN chmod +x /app/start.sh

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://127.0.0.1:8000/health || exit 1
CMD ["/app/start.sh"]
