import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";
import {
  createBillingCache,
  createBillingRefresher,
  fetchBillingSnapshot,
  type BillingSnapshot,
} from "../extensions/commandcode/billing.js";

const PERIOD_END = "2026-09-30T00:00:00Z";
const MAX_DATE_MS = 8.64e15;
const SNAPSHOT: BillingSnapshot = {
  monthly: 5,
  purchased: 2,
  free: 1,
  periodEnd: Date.parse(PERIOD_END),
};
const VALID_CREDITS = {
  credits: { monthlyCredits: 5, purchasedCredits: 2, freeCredits: 1 },
};
const VALID_SUBSCRIPTIONS = {
  data: {
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-09-01T00:00:00Z",
    currentPeriodEnd: PERIOD_END,
  },
};

const staleDirs: string[] = [];

afterEach(async () => {
  const dirs = staleDirs.splice(0, staleDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStore(now: () => number = Date.now): Promise<AccountStore> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-billing-"));
  staleDirs.push(dir);
  return new AccountStore({ path: join(dir, "accounts.json"), now });
}

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

function billingFetch(creditsPayload: unknown, subscriptionsPayload: unknown): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    if (url.endsWith("/alpha/billing/credits")) return jsonResponse(creditsPayload);
    if (url.endsWith("/alpha/billing/subscriptions")) return jsonResponse(subscriptionsPayload);
    return jsonResponse({ error: "missing" }, 404);
  };
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

  it("Given negative monthly, purchased, or free credits, When fetchBillingSnapshot runs, Then it returns undefined", async () => {
    const negative = [
      { monthlyCredits: -1, purchasedCredits: 0, freeCredits: 0 },
      { monthlyCredits: 0, purchasedCredits: -1, freeCredits: 0 },
      { monthlyCredits: 0, purchasedCredits: 0, freeCredits: -1 },
    ] as const;
    for (const credits of negative) {
      await expect(
        fetchBillingSnapshot({
          apiKey: "k",
          fetchImpl: billingFetch({ credits }, VALID_SUBSCRIPTIONS),
          apiBase: "https://api.commandcode.ai",
        }),
      ).resolves.toBeUndefined();
    }
  });

  it("Given a periodEnd outside [0, 8.64e15], When fetchBillingSnapshot runs, Then it returns undefined", async () => {
    const overflowSubscriptions = {
      data: {
        planId: "pro",
        status: "active",
        currentPeriodStart: "2026-09-01T00:00:00Z",
        currentPeriodEnd: "+275760-09-14T00:00:00.000Z",
      },
    };
    const preEpochSubscriptions = {
      data: {
        planId: "pro",
        status: "active",
        currentPeriodStart: "1969-01-01T00:00:00Z",
        currentPeriodEnd: "1969-12-31T00:00:00Z",
      },
    };
    await expect(
      fetchBillingSnapshot({
        apiKey: "k",
        fetchImpl: billingFetch(VALID_CREDITS, overflowSubscriptions),
        apiBase: "https://api.commandcode.ai",
      }),
    ).resolves.toBeUndefined();
    await expect(
      fetchBillingSnapshot({
        apiKey: "k",
        fetchImpl: billingFetch(VALID_CREDITS, preEpochSubscriptions),
        apiBase: "https://api.commandcode.ai",
      }),
    ).resolves.toBeUndefined();
  });

  it("Given a valid credits and subscriptions payload, When fetchBillingSnapshot runs, Then it returns the snapshot", async () => {
    await expect(
      fetchBillingSnapshot({
        apiKey: "k",
        fetchImpl: billingFetch(VALID_CREDITS, VALID_SUBSCRIPTIONS),
        apiBase: "https://api.commandcode.ai",
      }),
    ).resolves.toEqual(SNAPSHOT);
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

describe("createBillingRefresher", () => {
  const goodCredits = {
    monthly: 4,
    purchased: 1,
    free: 2,
    periodEnd: SNAPSHOT.periodEnd,
  } as const;

  it("Given an invalid snapshot, When the refresher runs against a good accounts file, Then the file stays loadable with the previous credits", async () => {
    const now = (): number => 1_700_000_000_000;
    const store = await tempStore(now);
    await store.add({
      id: "a",
      token: "token-a",
      createdAt: new Date(now()).toISOString(),
      credits: goodCredits,
    });

    const negativeFetch: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/credits")) {
        return jsonResponse({ credits: { monthlyCredits: -1, purchasedCredits: 0, freeCredits: 0 } });
      }
      return jsonResponse({
        data: {
          planId: "pro",
          status: "active",
          currentPeriodStart: "2023-11-01T00:00:00Z",
          currentPeriodEnd: "2023-12-01T00:00:00Z",
        },
      });
    };
    await createBillingRefresher({
      store,
      billingCache: createBillingCache({ now }),
      fetchBilling: (apiKey) => fetchBillingSnapshot({ apiKey, fetchImpl: negativeFetch }),
    })("token-a");

    const afterNegative = await store.load();
    expect(afterNegative[0]?.credits).toEqual(goodCredits);

    const overflow: BillingSnapshot = {
      monthly: 1,
      purchased: 0,
      free: 0,
      periodEnd: MAX_DATE_MS + 1,
    };
    await createBillingRefresher({
      store,
      billingCache: createBillingCache({ now }),
      fetchBilling: async () => overflow,
    })("token-a");

    const afterOverflow = await store.load();
    expect(afterOverflow[0]?.credits).toEqual(goodCredits);
  });

  it("Given two sequential refresh calls within TTL, When they run, Then fetchImpl is called once", async () => {
    const now = (): number => 1_700_000_000_000;
    const store = await tempStore(now);
    await store.add({ id: "a", token: "token-a", createdAt: new Date(now()).toISOString() });
    let calls = 0;
    const refresh = createBillingRefresher({
      store,
      billingCache: createBillingCache({ now }),
      fetchBilling: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });

    await refresh("token-a");
    await refresh("token-a");

    expect(calls).toBe(1);
  });

  it("Given a cached snapshot, When the TTL expires on an injected clock, Then the next refresh fetches again", async () => {
    let nowMs = 1_000_000;
    const store = await tempStore(() => nowMs);
    await store.add({ id: "a", token: "token-a", createdAt: new Date(nowMs).toISOString() });
    let calls = 0;
    const refresh = createBillingRefresher({
      store,
      billingCache: createBillingCache({ ttlMs: 1_000, now: () => nowMs }),
      fetchBilling: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });

    await refresh("token-a");
    expect(calls).toBe(1);

    nowMs = 1_000_999;
    await refresh("token-a");
    expect(calls).toBe(1);

    nowMs = 1_001_000;
    await refresh("token-a");
    expect(calls).toBe(2);
  });

  it("Given concurrent refresh calls for one key, When they run together, Then billing is fetched once", async () => {
    const now = (): number => 1_700_000_000_000;
    const store = await tempStore(now);
    await store.add({ id: "a", token: "token-a", createdAt: new Date(now()).toISOString() });
    let calls = 0;
    const refresh = createBillingRefresher({
      store,
      billingCache: createBillingCache({ now }),
      fetchBilling: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });

    await Promise.all([refresh("token-a"), refresh("token-a"), refresh("token-a")]);

    expect(calls).toBe(1);
  });
});
