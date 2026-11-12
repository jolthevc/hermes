import { describe, expect, it } from "vitest";
import { backoffMs, classify, HermesError, RETRY_POLICY } from "./errors.js";

describe("error classification", () => {
  it("keeps explicit classes", () => {
    expect(classify(new HermesError("x", "budget"))).toBe("budget");
  });
  it("detects transient network errors", () => {
    expect(classify(new Error("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classify(new Error("OpenRouter 503: overloaded"))).toBe("transient");
  });
  it("treats unknown errors as fatal", () => {
    expect(classify(new Error("undefined is not a function"))).toBe("fatal");
  });
  it("never retries budget errors", () => {
    expect(RETRY_POLICY.budget.retry).toBe(false);
  });
  it("backs off exponentially and respects hints", () => {
    const p = RETRY_POLICY.transient;
    expect(backoffMs(p, 3)).toBeGreaterThanOrEqual(p.baseDelayMs * 4);
    expect(backoffMs(p, 1, 60_000)).toBeGreaterThanOrEqual(60_000);
  });
});
