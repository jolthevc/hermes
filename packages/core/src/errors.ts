// Error classes drive the self-healing playbook: each class has its own retry policy.
export type ErrorClass =
  | "transient" // network, 429, 5xx, timeouts: retry with backoff
  | "bad_output" // model output failed schema/validation: retry (re-prompt), then fall back
  | "refusal" // model declined: fall back to another model, then park
  | "budget" // spend cap reached: park, no retry (Brain decides)
  | "invalid_input" // upstream artifact is wrong: park for Medic (regenerate upstream)
  | "fatal"; // bug or unknown: park, open incident

export class HermesError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HermesError";
  }
}

export const isHermesError = (e: unknown): e is HermesError => e instanceof HermesError;

export function classify(e: unknown): ErrorClass {
  if (isHermesError(e)) return e.errorClass;
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|timeout|429|50[0-9]/i.test(msg)) return "transient";
  if (/ZodError|JSON|schema/i.test(msg)) return "bad_output";
  return "fatal";
}

export interface RetryPolicy {
  retry: boolean;
  baseDelayMs: number;
  maxAttempts: number;
}

export const RETRY_POLICY: Record<ErrorClass, RetryPolicy> = {
  transient: { retry: true, baseDelayMs: 5_000, maxAttempts: 6 },
  bad_output: { retry: true, baseDelayMs: 1_000, maxAttempts: 3 },
  refusal: { retry: true, baseDelayMs: 1_000, maxAttempts: 2 },
  budget: { retry: false, baseDelayMs: 0, maxAttempts: 1 },
  invalid_input: { retry: false, baseDelayMs: 0, maxAttempts: 1 },
  fatal: { retry: true, baseDelayMs: 30_000, maxAttempts: 2 },
};

export function backoffMs(policy: RetryPolicy, attempt: number, hintMs?: number): number {
  const exp = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * 0.25 * exp;
  return Math.max(hintMs ?? 0, Math.min(exp + jitter, 15 * 60_000));
}
