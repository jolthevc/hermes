import { requireEnv } from "../env.js";
import { HermesError } from "../errors.js";

// SaladCloud GPU backend. GPU workers run as Salad container groups attached to a Salad Job Queue.
// We submit jobs (inputs = presigned GET URLs, outputs = presigned PUT URLs); the container's job-queue
// worker forwards each job to the container's local HTTP endpoint. Nodes never hold our DB or storage creds.
// API reference: https://docs.salad.com/reference/saladcloud-api (verified: create-job path, statuses).

const BASE = "https://api.salad.com/api/public";

export type SaladJobStatus = "pending" | "running" | "succeeded" | "cancelled" | "failed";

export interface SaladJob<I = unknown, O = unknown> {
  id: string;
  input: I;
  output?: O;
  metadata?: Record<string, unknown>;
  status: SaladJobStatus;
  events: { action: string; time: string }[];
  create_time: string;
  update_time: string;
}

function projectPath() {
  return `${BASE}/organizations/${requireEnv("SALAD_ORG")}/projects/${requireEnv("SALAD_PROJECT")}`;
}

async function salad<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Salad-Api-Key": requireEnv("SALAD_API_KEY"),
        // Salad's PATCH endpoints require JSON merge-patch.
        "Content-Type": method === "PATCH" ? "application/merge-patch+json" : "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new HermesError(`Salad request failed: ${(e as Error).message}`, "transient");
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new HermesError(
      `Salad ${method} ${res.status}: ${text}`,
      res.status === 429 || res.status >= 500 ? "transient" : "fatal",
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function submitJob<I>(queue: string, input: I, metadata?: Record<string, unknown>, webhook?: string) {
  return salad<SaladJob<I>>("POST", `${projectPath()}/queues/${queue}/jobs`, { input, metadata, webhook });
}

export function getJob<I, O>(queue: string, jobId: string) {
  return salad<SaladJob<I, O>>("GET", `${projectPath()}/queues/${queue}/jobs/${jobId}`);
}

export function cancelJob(queue: string, jobId: string) {
  return salad<void>("DELETE", `${projectPath()}/queues/${queue}/jobs/${jobId}`);
}

// ---------- provisioning ----------
export function listQueues() {
  return salad<{ items: { name: string }[] }>("GET", `${projectPath()}/queues`);
}

export function createQueue(name: string, description: string) {
  return salad<Record<string, unknown>>("POST", `${projectPath()}/queues`, {
    name,
    display_name: name,
    description,
  });
}

export function listContainerGroups() {
  return salad<{ items: { name: string; current_state?: { status?: string } }[] }>(
    "GET",
    `${projectPath()}/containers`,
  );
}

export async function gpuClassIds(names: string[]) {
  const r = await salad<{ items: { id: string; name: string }[] }>(
    "GET",
    `${BASE}/organizations/${requireEnv("SALAD_ORG")}/gpu-classes`,
  );
  return r.items.filter((g) => names.some((n) => g.name.startsWith(n))).map((g) => g.id);
}

export interface WorkerGroupSpec {
  name: string;
  image: string;
  queue: string;
  gpuClassIds: string[];
  cpu: number;
  memoryMb: number;
  storageGb: number;
  maxReplicas: number;
  env?: Record<string, string>;
  registryAuth?: { basic?: { username: string; password: string } };
  priority?: "high" | "medium" | "low" | "batch";
}

/** Container group wired to a Salad Job Queue, scale-to-zero via the queue autoscaler. */
export function createWorkerGroup(s: WorkerGroupSpec) {
  return salad<Record<string, unknown>>("POST", `${projectPath()}/containers`, {
    name: s.name,
    display_name: s.name,
    autostart_policy: true,
    restart_policy: "always",
    replicas: 0,
    container: {
      image: s.image,
      image_caching: true,
      priority: s.priority ?? "high",
      environment_variables: { PORT: "8000", ...s.env },
      resources: {
        cpu: s.cpu,
        memory: s.memoryMb,
        gpu_classes: s.gpuClassIds,
        storage_amount: s.storageGb * 1024 ** 3,
        shm_size: 2048,
      },
      ...(s.registryAuth ? { registry_authentication: s.registryAuth } : {}),
    },
    // Model weights download + load on start: give readiness plenty of time (the job worker waits for it).
    readiness_probe: {
      http: { path: "/health", port: 8000, scheme: "http", headers: [] },
      initial_delay_seconds: 30,
      period_seconds: 10,
      timeout_seconds: 5,
      success_threshold: 1,
      failure_threshold: 3,
    },
    queue_connection: { path: "/process", port: 8000, queue_name: s.queue },
    queue_autoscaler: {
      min_replicas: 0,
      max_replicas: s.maxReplicas,
      desired_queue_length: 2,
      polling_period: 30,
      max_upscale_per_minute: 5,
      max_downscale_per_minute: 2,
    },
  });
}

// Container groups (scaling is the Brain's job: replicas follow queue depth, 0 when idle).
export function getContainerGroup(name: string) {
  return salad<Record<string, unknown>>("GET", `${projectPath()}/containers/${name}`);
}

export function setImage(name: string, image: string) {
  return salad<Record<string, unknown>>("PATCH", `${projectPath()}/containers/${name}`, { container: { image } });
}

export function setGpuClasses(name: string, gpuClassIds: string[]) {
  return salad<Record<string, unknown>>("PATCH", `${projectPath()}/containers/${name}`, {
    container: { resources: { gpu_classes: gpuClassIds } },
  });
}

export function setReplicas(name: string, replicas: number) {
  return salad<Record<string, unknown>>("PATCH", `${projectPath()}/containers/${name}`, { replicas });
}

export function startContainerGroup(name: string) {
  return salad<void>("POST", `${projectPath()}/containers/${name}/start`);
}

export function stopContainerGroup(name: string) {
  return salad<void>("POST", `${projectPath()}/containers/${name}/stop`);
}
