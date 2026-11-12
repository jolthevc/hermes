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
      headers: { "Salad-Api-Key": requireEnv("SALAD_API_KEY"), "Content-Type": "application/json" },
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

// Container groups (scaling is the Brain's job: replicas follow queue depth, 0 when idle).
export function getContainerGroup(name: string) {
  return salad<Record<string, unknown>>("GET", `${projectPath()}/containers/${name}`);
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
