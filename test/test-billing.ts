import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountPool } from "../extensions/commandcode/accounts/pool.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";
import {
  createBillingCache,
  createBillingRefresher,
  fetchBillingSnapshot,
  type BillingSnapshot,
} from "../extensions/commandcode/billing.js";

const NOW = 1_700_000_000_000;
const PERIOD_END = "2026-09-30T00:00:00Z";
const SNAPSHOT: BillingSnapshot = {
  monthly: 5,
  purchased: 2,
  free: 1,
  periodEnd: Date.parse(PERIOD_END),
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const credits = { credits: { monthlyCredits: 5, purchasedCredits: 2, freeCredits: 1 } };
const subscription = {
  data: {
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-09-01T00:00:00Z",
    currentPeriodEnd: PERIOD_END,
  },
};

function successfulFetch(seen: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = urlOf(input);
    seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
    return json(url.endsWith("/credits") ? credits : subscription);
  };
}

async function setup(): Promise<{
  readonly store: AccountStore;
  readonly pool: AccountPool;
  readonly path: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-billing-"));
  directories.push(dir);
  const path = join(dir, "accounts.json");
  const store = new AccountStore({ path, now: () => NOW });
  await store.add({ id: "plain", token: "plain" });
  await store.add({ id: "billed", token: "billed" });
  return { store, pool: new AccountPool({ store, now: () => NOW }), path };
}

describe("fetchBillingSnapshot", () => {
  it("fetches credits and subscriptions read-only with bearer authentication", async () => {
    const seen: string[] = [];
    await expect(fetchBillingSnapshot({
      apiKey: "key",
      apiBase: "https://api.example.test/",
      fetchImpl: successfulFetch(seen),
    })).resolves.toEqual(SNAPSHOT);
    expect(seen).toEqual([
      "https://api.example.test/alpha/billing/credits Bearer key",
      "https://api.example.test/alpha/billing/subscriptions Bearer key",
    ]);
  });

  it("accepts top-level subscription data", async () => {
    const fetchImpl: typeof fetch = async (input) =>
      json(urlOf(input).endsWith("/credits") ? credits : subscription.data);
    await expect(fetchBillingSnapshot({ apiKey: "key", fetchImpl })).resolves.toEqual(SNAPSHOT);
  });

  it.each([
    async () => { throw new Error("offline"); },
    async () => json({}, 500),
    async () => json({ credits: { monthlyCredits: -1 } }),
  ] as readonly (typeof fetch)[])("returns undefined for failed or malformed billing responses %#", async (fetchImpl) => {
    await expect(fetchBillingSnapshot({ apiKey: "key", fetchImpl })).resolves.toBeUndefined();
  });
});

describe("billing TTL cache", () => {
  it("returns snapshots until the exact TTL boundary", () => {
    let now = 1000;
    const cache = createBillingCache({ ttlMs: 100, now: () => now });
    cache.set("key", SNAPSHOT);
    now = 1099;
    expect(cache.get("key")).toEqual(SNAPSHOT);
    now = 1100;
    expect(cache.get("key")).toBeUndefined();
  });
});

describe("in-memory billing refresh", () => {
  it("feeds pool ordering without writing the accounts file", async () => {
    const { pool, path } = await setup();
    const before = await readFile(path);
    const refresh = createBillingRefresher({
      pool,
      billingCache: createBillingCache({ now: () => NOW }),
      fetchBilling: async () => ({ ...SNAPSHOT, periodEnd: NOW + 60_000 }),
    });

    await refresh("billed");

    expect((await pool.ordered()).map((account) => account.id)).toEqual(["billed", "plain"]);
    expect(await readFile(path)).toEqual(before);
  });

  it("deduplicates concurrent fetches and honors cached TTL", async () => {
    const { pool } = await setup();
    let calls = 0;
    const refresh = createBillingRefresher({
      pool,
      billingCache: createBillingCache({ now: () => NOW }),
      fetchBilling: async () => {
        calls += 1;
        return SNAPSHOT;
      },
    });

    await Promise.all([refresh("billed"), refresh("billed"), refresh("billed")]);
    await refresh("billed");
    expect(calls).toBe(1);
  });

  it("never rejects failed polling and allows a later retry", async () => {
    const { pool } = await setup();
    let fail = true;
    let calls = 0;
    const refresh = createBillingRefresher({
      pool,
      billingCache: createBillingCache({ now: () => NOW }),
      fetchBilling: async () => {
        calls += 1;
        if (fail) throw new Error("offline");
        return SNAPSHOT;
      },
    });

    await expect(refresh("billed")).resolves.toBeUndefined();
    fail = false;
    await expect(refresh("billed")).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
