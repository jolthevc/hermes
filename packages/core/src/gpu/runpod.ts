import { requireEnv } from "../env.js";
import { HermesError } from "../errors.js";

// RunPod Serverless: REST (rest.runpod.io/v1) for templates/endpoints, queue API (api.runpod.ai/v2) for jobs.

const REST = "https://rest.runpod.io/v1";
const JOBS = "https://api.runpod.ai/v2";

async function rp<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${requireEnv("RUNPOD_API_KEY")}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new HermesError(`RunPod request failed: ${(e as Error).message}`, "transient");
  }
  const text = await res.text();
  if (!res.ok)
    throw new HermesError(
      `RunPod ${method} ${url.replace(/^https:\/\/[^/]+/, "")} ${res.status}: ${text.slice(0, 400)}`,
      res.status === 429 || res.status >= 500 ? "transient" : "fatal",
    );
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------- provisioning ----------
export interface RpTemplate {
  id: string;
  name: string;
  imageName: string;
}
export interface RpEndpoint {
  id: string;
  name: string;
  templateId: string;
  workersMax?: number;
}

export const listTemplates = () => rp<RpTemplate[]>("GET", `${REST}/templates`);
export const listEndpoints = () => rp<RpEndpoint[]>("GET", `${REST}/endpoints`);

export function createTemplate(t: {
  name: string;
  imageName: string;
  env: Record<string, string>;
  containerDiskInGb: number;
}) {
  return rp<RpTemplate>("POST", `${REST}/templates`, { ...t, isServerless: true });
}

export function updateTemplate(id: string, patch: Partial<{ imageName: string; env: Record<string, string> }>) {
  return rp<RpTemplate>("PATCH", `${REST}/templates/${id}`, patch);
}

export function createEndpoint(e: {
  name: string;
  templateId: string;
  gpuTypeIds: string[];
  workersMax: number;
  idleTimeout: number;
  executionTimeoutMs: number;
}) {
  return rp<RpEndpoint>("POST", `${REST}/endpoints`, {
    ...e,
    computeType: "GPU",
    gpuCount: 1,
    workersMin: 0,
    flashboot: true,
    scalerType: "QUEUE_DELAY",
    scalerValue: 4,
  });
}

// ---------- jobs ----------
export type RpStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";

export interface RpJob<O = unknown> {
  id: string;
  status: RpStatus;
  output?: O;
  error?: string;
  delayTime?: number; // ms waiting in queue (incl. cold start)
  executionTime?: number; // ms running
}

export function run<I>(endpointId: string, input: I, executionTimeoutMs = 30 * 60_000) {
  return rp<RpJob>("POST", `${JOBS}/${endpointId}/run`, { input, policy: { executionTimeout: executionTimeoutMs } });
}

export function status<O>(endpointId: string, jobId: string) {
  return rp<RpJob<O>>("GET", `${JOBS}/${endpointId}/status/${jobId}`);
}

export function cancel(endpointId: string, jobId: string) {
  return rp<RpJob>("POST", `${JOBS}/${endpointId}/cancel/${jobId}`);
}
