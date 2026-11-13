import { requireEnv } from "../env.js";
import { HermesError } from "../errors.js";

// Vast.ai REST client (on-demand instances; the Brain manages the fleet itself).
// Offer search format verified against the live API (POST /bundles/).

const BASE = "https://console.vast.ai/api/v0";

async function vast<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${requireEnv("VAST_API_KEY")}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new HermesError(`Vast request failed: ${(e as Error).message}`, "transient");
  }
  const text = await res.text();
  if (!res.ok)
    throw new HermesError(
      `Vast ${method} ${path} ${res.status}: ${text.slice(0, 400)}`,
      res.status === 429 || res.status >= 500 ? "transient" : "fatal",
    );
  return (text ? JSON.parse(text) : {}) as T;
}

export interface VastOffer {
  id: number;
  gpu_name: string;
  gpu_ram: number;
  dph_total: number;
  reliability2?: number;
  reliability?: number;
  inet_down: number;
  cuda_max_good: number;
  compute_cap: number;
  geolocation?: string;
  machine_id: number;
}

export interface OfferFilter {
  minGpuRamMb: number;
  minComputeCap?: number; // 800 = Ampere (bf16)
  minReliability?: number;
  minInetDown?: number;
  minCuda?: number;
  maxDph?: number;
  minDiskGb?: number;
  excludeMachineIds?: number[];
  limit?: number;
}

export async function searchOffers(f: OfferFilter): Promise<VastOffer[]> {
  const q: Record<string, unknown> = {
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    external: { eq: false },
    num_gpus: { eq: 1 },
    gpu_ram: { gte: f.minGpuRamMb },
    compute_cap: { gte: f.minComputeCap ?? 800 },
    reliability2: { gte: f.minReliability ?? 0.98 },
    inet_down: { gte: f.minInetDown ?? 300 },
    cuda_max_good: { gte: f.minCuda ?? 12.8 },
    direct_port_count: { gte: 1 },
    disk_space: { gte: f.minDiskGb ?? 60 },
    ...(f.maxDph ? { dph_total: { lte: f.maxDph } } : {}),
    order: [["dph_total", "asc"]],
    type: "on-demand",
    limit: f.limit ?? 10,
  };
  const r = await vast<{ offers?: VastOffer[] }>("POST", "/bundles/", q);
  const excl = new Set(f.excludeMachineIds ?? []);
  return (r.offers ?? []).filter((o) => !excl.has(o.machine_id));
}

export interface CreateInstance {
  offerId: number;
  image: string;
  diskGb: number;
  label: string;
  env: Record<string, string>;
  ports: number[];
}

export async function createInstance(c: CreateInstance): Promise<number> {
  const env = [...c.ports.map((p) => `-p ${p}:${p}`), ...Object.entries(c.env).map(([k, v]) => `-e ${k}=${v}`)].join(
    " ",
  );
  const r = await vast<{ success?: boolean; new_contract?: number; error?: string; msg?: string }>(
    "PUT",
    `/asks/${c.offerId}/`,
    { image: c.image, disk: c.diskGb, label: c.label, runtype: "args", env, target_state: "running" },
  );
  if (!r.success || !r.new_contract)
    throw new HermesError(`Vast create failed: ${r.error ?? r.msg ?? JSON.stringify(r)}`, "transient");
  return r.new_contract;
}

export interface VastInstance {
  id: number;
  label?: string;
  actual_status?: string | null;
  intended_status?: string;
  cur_state?: string;
  status_msg?: string;
  public_ipaddr?: string;
  ports?: Record<string, { HostIp: string; HostPort: string }[]>;
  dph_total?: number;
  gpu_name?: string;
  machine_id?: number;
  start_date?: number;
}

export async function listInstances(): Promise<VastInstance[]> {
  const r = await vast<{ instances?: VastInstance[] }>("GET", "/instances/");
  return r.instances ?? [];
}

export async function getInstance(id: number): Promise<VastInstance | null> {
  const r = await vast<{ instances?: VastInstance | VastInstance[] }>("GET", `/instances/${id}/`);
  const i = Array.isArray(r.instances) ? r.instances[0] : r.instances;
  return i ?? null;
}

export async function destroyInstance(id: number) {
  await vast("DELETE", `/instances/${id}/`);
}

/** Public URL for a container port, once the host has mapped it. */
export function portUrl(i: VastInstance, port: number): string | null {
  const m = i.ports?.[`${port}/tcp`]?.[0];
  if (!i.public_ipaddr || !m?.HostPort) return null;
  return `http://${i.public_ipaddr.trim()}:${m.HostPort}`;
}
