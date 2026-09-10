import { describe, expect, it } from "vitest";
import {
  createBillingCache,
  fetchBillingSnapshot,
  type BillingSnapshot,
} from "../extensions/commandcode/billing.js";

const PERIOD_END = "2026-09-30T00:00:00Z";
const SNAPSHOT: BillingSnapshot = {
  monthly: 5,
  purchased: 2,
  free: 1,
  periodEnd: Date.parse(PERIOD_END),
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function authorization(init: RequestInit | undefined): string | null {
  if (init === undefined || init.headers === undefined) return null;
  return new Headers(init.headers).get("Authorization");
}

describe("fetchBillingSnapshot", () => {
  it("Given credits and nested subscriptions payloads, When fetchBillingSnapshot runs, Then it returns the snapshot and authenticates both GETs", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      seen.push(`${init?.method ?? "GET"} ${url} ${authorization(init)}`);
      if (url === "https://api.commandcode.ai/alpha/billing/credits") {
        return jsonResponse({
          credits: { monthlyCredits: 5, purchasedCredits: 2, freeCredits: 1 },
        });
      }
      if (url === "https://api.commandcode.ai/alpha/billing/subscriptions") {
        return jsonResponse({
          data: {
            planId: "pro",
            status: "active",
            currentPeriodStart: "2026-09-01T00:00:00Z",
            currentPeriodEnd: PERIOD_END,
          },
        });
      }
      return jsonResponse({ error: "missing" }, 404);
    };

    const snapshot = await fetchBillingSnapshot({
      apiKey: "key-1",
      fetchImpl,
      apiBase: "https://api.commandcode.ai",
      now: () => 0,
    });

    expect(snapshot).toEqual(SNAPSHOT);
    expect(seen).toEqual([
      "GET https://api.commandcode.ai/alpha/billing/credits Bearer key-1",
      "GET https://api.commandcode.ai/alpha/billing/subscriptions Bearer key-1",
    ]);
  });

  it("Given subscription fields at the top level, When fetchBillingSnapshot runs, Then it still returns the snapshot", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/alpha/billing/credits")) {
        return jsonResponse({
          credits: { monthlyCredits: 5, purchasedCredits: 2, freeCredits: 1 },
        });
      }
      return jsonResponse({
        planId: "pro",
        status: "active",
        currentPeriodStart: "2026-09-01T00:00:00Z",
        currentPeriodEnd: PERIOD_END,
      });
    };

    await expect(
      fetchBillingSnapshot({
        apiKey: "key-1",
        fetchImpl,
        apiBase: "https://api.example.test",
        now: () => 0,
      }),
    ).resolves.toEqual(SNAPSHOT);
  });

  it("Given a non-2xx credits or subscriptions response, When fetchBillingSnapshot runs, Then it returns undefined and does not throw", async () => {
    const creditsFail: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/alpha/billing/credits")) return jsonResponse({}, 500);
      return jsonResponse({
        data: {
          planId: "pro",
          status: "active",
          currentPeriodStart: "2026-09-01T00:00:00Z",
          currentPeriodEnd: PERIOD_END,
        },
      });
    };
    const subscriptionsFail: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/alpha/billing/credits")) {
        return jsonResponse({
          credits: { monthlyCredits: 5, purchasedCredits: 2, freeCredits: 1 },
        });
      }
      return jsonResponse({}, 401);
    };

    await expect(
      fetchBillingSnapshot({ apiKey: "k", fetchImpl: creditsFail, apiBase: "https://api.commandcode.ai" }),
    ).resolves.toBeUndefined();
    await expect(
      fetchBillingSnapshot({
        apiKey: "k",
        fetchImpl: subscriptionsFail,
        apiBase: "https://api.commandcode.ai",
      }),
    ).resolves.toBeUndefined();
  });

  it("Given a network failure or malformed payload, When fetchBillingSnapshot runs, Then it returns undefined and does not throw", async () => {
    const networkFail: typeof fetch = async () => {
      throw new Error("offline");
    };
    const malformed: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/alpha/billing/credits")) return jsonResponse({ credits: { monthlyCredits: "nope" } });
      return jsonResponse({ data: { planId: "pro" } });
    };

    await expect(
      fetchBillingSnapshot({ apiKey: "k", fetchImpl: networkFail, apiBase: "https://api.commandcode.ai" }),
    ).resolves.toBeUndefined();
    await expect(
      fetchBillingSnapshot({ apiKey: "k", fetchImpl: malformed, apiBase: "https://api.commandcode.ai" }),
    ).resolves.toBeUndefined();
  });
});

describe("createBillingCache", () => {
  it("Given a snapshot written to the cache, When get is called before expiry, Then it returns the snapshot and misses after TTL", () => {
    let nowMs = 1_000_000;
    const cache = createBillingCache({ ttlMs: 1_000, now: () => nowMs });

    expect(cache.get("key-1")).toBeUndefined();
    cache.set("key-1", SNAPSHOT);
    expect(cache.get("key-1")).toEqual(SNAPSHOT);
    expect(cache.get("key-2")).toBeUndefined();

    nowMs = 1_000_999;
    expect(cache.get("key-1")).toEqual(SNAPSHOT);

    nowMs = 1_001_000;
    expect(cache.get("key-1")).toBeUndefined();
  });

  it("Given COMMANDCODE_BILLING_TTL_MS, When createBillingCache omits ttlMs, Then the env TTL is honored", () => {
    const previous = process.env.COMMANDCODE_BILLING_TTL_MS;
    process.env.COMMANDCODE_BILLING_TTL_MS = "5000";
    try {
      let nowMs = 10_000;
      const cache = createBillingCache({ now: () => nowMs });
      cache.set("key-1", SNAPSHOT);
      nowMs = 14_999;
      expect(cache.get("key-1")).toEqual(SNAPSHOT);
      nowMs = 15_000;
      expect(cache.get("key-1")).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.COMMANDCODE_BILLING_TTL_MS;
      } else {
        process.env.COMMANDCODE_BILLING_TTL_MS = previous;
      }
    }
  });
});
