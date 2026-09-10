import { dirname, join } from "node:path";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  AccountStoreError,
  parseAccountFile,
  serializeAccountFile,
  type AccountCredits,
  type AccountRecord,
  type AccountRecordInput,
} from "../extensions/commandcode/accounts/schema.js";
import {
  AccountStore,
  resolveAccountsFilePath,
} from "../extensions/commandcode/accounts/store.js";
import {
  AccountPool,
  DEFAULT_EXPIRY_WINDOW_MS,
  NoHealthyAccountsError,
  resolveExpiryWindowMs,
} from "../extensions/commandcode/accounts/pool.js";

const BASE = 1_700_000_000_000;
const HOUR = 3_600_000;

interface Clock {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
}

function makeClock(): Clock {
  let nowMs = BASE;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const staleDirs: string[] = [];

afterEach(async () => {
  const dirs = staleDirs.splice(0, staleDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-accounts-"));
  staleDirs.push(dir);
  return dir;
}

function account(spec: {
  readonly id: string;
  readonly token?: string;
  readonly enabled?: boolean;
  readonly retryAt?: number;
  readonly createdAt?: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly keyName?: string;
  readonly credits?: AccountCredits;
}): AccountRecordInput {
  return {
    id: spec.id,
    token: spec.token ?? `token-${spec.id}`,
    enabled: spec.enabled,
    retryAt: spec.retryAt,
    createdAt: spec.createdAt,
    userId: spec.userId,
    userName: spec.userName,
    keyName: spec.keyName,
    credits: spec.credits,
  };
}

function credits(periodEnd: number): AccountCredits {
  return { monthly: 100, purchased: 0, free: 20, periodEnd };
}

async function setupStore(relativePath = "accounts.json"): Promise<{
  readonly store: AccountStore;
  readonly path: string;
  readonly clock: Clock;
}> {
  const dir = await tempDir();
  const path = join(dir, relativePath);
  const clock = makeClock();
  return { store: new AccountStore({ path, now: clock.now }), path, clock };
}

async function setupPool(
  inputs: readonly AccountRecordInput[],
  expiryWindowMs: number = DEFAULT_EXPIRY_WINDOW_MS,
): Promise<{
  readonly store: AccountStore;
  readonly pool: AccountPool;
  readonly path: string;
  readonly clock: Clock;
}> {
  const dir = await tempDir();
  const path = join(dir, "accounts.json");
  const clock = makeClock();
  const store = new AccountStore({ path, now: clock.now });
  for (const input of inputs) await store.add(input);
  const pool = new AccountPool({ store, now: clock.now, expiryWindowMs });
  return { store, pool, path, clock };
}

async function readRawAccounts(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
  return parsed;
}

async function nextFailure(pool: AccountPool, nowMs?: number): Promise<NoHealthyAccountsError> {
  const error = await pool.next(nowMs).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof NoHealthyAccountsError)) {
    throw new Error(`expected NoHealthyAccountsError, received ${String(error)}`);
  }
  return error;
}

const fullPayloadEntry = {
  id: "a",
  token: "tok-a",
  userId: "u1",
  userName: "Ada",
  keyName: "key-1",
  enabled: false,
  retryAt: 123,
  createdAt: "2026-01-01T00:00:00.000Z",
  credits: { monthly: 1, purchased: 2, free: 3, periodEnd: 4 },
};

const entry = (id: string, token: string): unknown => ({
  id,
  token,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const malformedPayloads: readonly {
  readonly name: string;
  readonly payload: unknown;
  readonly fragment: string;
}[] = [
  { name: "array root", payload: [], fragment: "accounts file to be a JSON object" },
  {
    name: "wrong version",
    payload: { version: 2, accounts: [] },
    fragment: "version 1",
  },
  {
    name: "accounts not an array",
    payload: { version: 1, accounts: {} },
    fragment: '"accounts" to be an array',
  },
  {
    name: "entry not an object",
    payload: { version: 1, accounts: [42] },
    fragment: "accounts[0] entry to be an object",
  },
  {
    name: "missing id",
    payload: { version: 1, accounts: [{ token: "t", createdAt: "2026-01-01T00:00:00.000Z" }] },
    fragment: '"id"',
  },
  {
    name: "missing token",
    payload: { version: 1, accounts: [{ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }] },
    fragment: '"token"',
  },
  {
    name: "non-ISO createdAt",
    payload: { version: 1, accounts: [{ id: "a", token: "t", createdAt: "yesterday" }] },
    fragment: "ISO",
  },
  {
    name: "non-boolean enabled",
    payload: {
      version: 1,
      accounts: [{ id: "a", token: "t", enabled: "yes", createdAt: "2026-01-01T00:00:00.000Z" }],
    },
    fragment: '"enabled"',
  },
  {
    name: "non-number retryAt",
    payload: {
      version: 1,
      accounts: [{ id: "a", token: "t", retryAt: "soon", createdAt: "2026-01-01T00:00:00.000Z" }],
    },
    fragment: '"retryAt"',
  },
  {
    name: "credits not an object",
    payload: {
      version: 1,
      accounts: [{ id: "a", token: "t", createdAt: "2026-01-01T00:00:00.000Z", credits: 5 }],
    },
    fragment: '"credits" to be an object',
  },
  {
    name: "negative credits field",
    payload: {
      version: 1,
      accounts: [
        {
          id: "a",
          token: "t",
          createdAt: "2026-01-01T00:00:00.000Z",
          credits: { monthly: -1, purchased: 0, free: 0, periodEnd: 1 },
        },
      ],
    },
    fragment: 'credits.monthly',
  },
];

describe("account file parsing", () => {
  test("Given a fully-populated payload, When parsing, Then every supported field round-trips", () => {
    const payload = { version: 1, accounts: [fullPayloadEntry] };
    expect(parseAccountFile(payload)).toEqual(payload);
  });

  test.each(malformedPayloads)("$name", ({ payload, fragment }) => {
    const attempt = (): unknown => parseAccountFile(payload);
    expect(attempt).toThrow(AccountStoreError);
    expect(attempt).toThrow(fragment);
  });

  test("Given two entries sharing an id, When parsing, Then the duplicate id is rejected", () => {
    const payload = { version: 1, accounts: [entry("a", "t1"), entry("a", "t2")] };
    expect(() => parseAccountFile(payload)).toThrow(AccountStoreError);
    expect(() => parseAccountFile(payload)).toThrow(/Duplicate account id "a"/);
  });

  test("Given two entries sharing a token, When parsing, Then the duplicate token is rejected", () => {
    const payload = { version: 1, accounts: [entry("a", "shared"), entry("b", "shared")] };
    expect(() => parseAccountFile(payload)).toThrow(AccountStoreError);
    expect(() => parseAccountFile(payload)).toThrow(/Duplicate account token/);
  });

  test("Given serialized records, When round-tripping serialize then parse, Then the records come back intact", () => {
    const records: readonly AccountRecord[] = [
      {
        id: "a",
        token: "tok-a",
        userId: "u1",
        userName: "Ada",
        keyName: "key-1",
        enabled: true,
        retryAt: 7,
        createdAt: "2026-01-01T00:00:00.000Z",
        credits: { monthly: 1, purchased: 2, free: 3, periodEnd: 4 },
      },
    ];
    const reparsed: unknown = JSON.parse(serializeAccountFile(records));
    expect(parseAccountFile(reparsed).accounts).toEqual(records);
  });
});

describe("account store", () => {
  test("Given a store over a missing nested directory, When adding an account, Then the file lands with mode 0600 and no temp leftovers", async () => {
    const { store, path } = await setupStore(join("nested", "deeper", "accounts.json"));
    await store.add(account({ id: "a" }));

    const stats = await stat(path);
    expect(stats.mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(path))).sort()).toEqual([
      "accounts.json",
      "accounts.json.dispositions",
      "accounts.v2.json",
    ]);

    const raw = await readRawAccounts(path);
    expect(raw).toEqual({
      version: 1,
      accounts: [
        { id: "a", token: "token-a", enabled: true, createdAt: new Date(BASE).toISOString() },
      ],
      lastAppliedSeq: expect.any(Number),
      dispositions: expect.any(Array),
    });
  });

  test("Given an existing account, When adding the same id or token again, Then the add is rejected", async () => {
    const { store } = await setupStore();
    await store.add(account({ id: "a", token: "shared" }));

    await expect(store.add(account({ id: "a", token: "other" }))).rejects.toThrow(AccountStoreError);
    await expect(store.add(account({ id: "b", token: "shared" }))).rejects.toThrow(
      "Account credential already exists",
    );
    const snapshot = store.accounts();
    expect(snapshot).toHaveLength(1);
  });

  test("Given accounts persisted by one store, When a second store loads the same path, Then removals and enabled flags are observed", async () => {
    const { store, path } = await setupStore();
    await store.add(account({ id: "a" }));
    await store.add(account({ id: "b" }));

    await store.remove("a");
    await store.setEnabled("b", false);

    const second = new AccountStore({ path });
    await second.load();
    expect(second.accounts().map((record) => [record.id, record.enabled])).toEqual([["b", false]]);

    await expect(store.remove("missing")).rejects.toThrow(AccountStoreError);
    await expect(store.setEnabled("missing", true)).rejects.toThrow(AccountStoreError);
  });

  test("Given three adds fired concurrently, When they all settle, Then every write landed in file order", async () => {
    const { store, path } = await setupStore();
    await Promise.all([
      store.add(account({ id: "a" })),
      store.add(account({ id: "b" })),
      store.add(account({ id: "c" })),
    ]);

    const second = new AccountStore({ path });
    await second.load();
    expect(second.accounts().map((record) => record.id)).toEqual(["a", "b", "c"]);
  });

  test("Given a mutate transform, When it clears a field, Then the transformed file is persisted atomically", async () => {
    const { store, path } = await setupStore();
    await store.add(account({ id: "a", retryAt: BASE + 5_000 }));

    await store.mutate((records) =>
      records.map((record) => (record.id === "a" ? { ...record, retryAt: undefined } : record)),
    );

    const raw = await readRawAccounts(path);
    expect(raw).toEqual({
      version: 1,
      accounts: [{ id: "a", token: "token-a", enabled: true, createdAt: new Date(BASE).toISOString() }],
      lastAppliedSeq: expect.any(Number),
      dispositions: expect.any(Array),
    });
  });

  test("Given a corrupt file on disk, When loading, Then AccountStoreError is thrown and no partial state is readable", async () => {
    const { store, path } = await setupStore();
    await writeFile(path, "{not json", "utf-8");
    await expect(store.load()).rejects.toThrow(AccountStoreError);
    expect(store.accounts()).toEqual([]);

    await writeFile(
      path,
      JSON.stringify({ version: 1, accounts: [{ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }] }),
      "utf-8",
    );
    await expect(store.load()).rejects.toThrow(/token/);
    expect(store.accounts()).toEqual([]);
  });

  test("Given no file on disk, When loading, Then the store starts empty", async () => {
    const { store } = await setupStore();
    await expect(store.load()).resolves.toEqual([]);
  });
});

describe("accounts path and expiry-window resolution", () => {
  test("Given an env override, When resolving the file path, Then the override wins over the home default", () => {
    expect(resolveAccountsFilePath({ COMMANDCODE_ACCOUNTS_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
    expect(resolveAccountsFilePath({})).toBe(join(homedir(), ".commandcode", "omo-accounts.json"));
  });

  test("Given expiry-window env values, When resolving, Then valid values parse, unset falls back, and invalid values are rejected", () => {
    expect(resolveExpiryWindowMs({})).toBe(DEFAULT_EXPIRY_WINDOW_MS);
    expect(resolveExpiryWindowMs({ COMMANDCODE_EXPIRY_WINDOW_MS: "3600000" })).toBe(3_600_000);
    expect(() => resolveExpiryWindowMs({ COMMANDCODE_EXPIRY_WINDOW_MS: "soon" })).toThrow(
      AccountStoreError,
    );
    expect(() => resolveExpiryWindowMs({ COMMANDCODE_EXPIRY_WINDOW_MS: "0" })).toThrow(
      AccountStoreError,
    );
  });
});

describe("account pool selection", () => {
  test("Given A without a credits snapshot and B with monthly credits expiring in +2h, When selecting, Then tier-0 B is returned", async () => {
    const { pool } = await setupPool([
      account({ id: "a" }),
      account({ id: "b", credits: credits(BASE + 2 * HOUR) }),
    ]);

    const lease = await pool.next();
    expect(lease.id).toBe("b");
    expect(lease.token).toBe("token-b");
    expect(lease.credits?.monthly).toBe(100);
    lease.unbind();
  });

  test("Given accounts expiring at -1h/+1h/+2h and a plain account, When selecting and quarantining down the order, Then only upcoming expiries are tier 0, sorted by periodEnd, then file-order tier 1", async () => {
    const { pool, clock } = await setupPool([
      account({ id: "plain" }),
      account({ id: "late", credits: credits(BASE + 2 * HOUR) }),
      account({ id: "mid", credits: credits(BASE + 1 * HOUR) }),
      account({ id: "expired", credits: credits(BASE - 1 * HOUR) }),
    ]);

    expect((await pool.next(clock.now())).id).toBe("mid");
    await pool.quarantine("mid", BASE + 60_000);
    expect((await pool.next()).id).toBe("late");
    await pool.quarantine("late", BASE + 60_000);
    expect((await pool.next()).id).toBe("plain");
    await pool.quarantine("plain", BASE + 60_000);
    expect((await pool.next()).id).toBe("expired");
  });

  test("Given a stale credits snapshot 30 days past periodEnd and an account expiring in one hour, When selecting, Then the stale snapshot stays tier 1", async () => {
    const { pool } = await setupPool([
      account({ id: "stale", credits: credits(BASE - 30 * DEFAULT_EXPIRY_WINDOW_MS) }),
      account({ id: "soon", credits: credits(BASE + 1 * HOUR) }),
    ]);

    expect((await pool.next(BASE)).id).toBe("soon");
    await pool.quarantine("soon", BASE + 60_000);
    expect((await pool.next(BASE)).id).toBe("stale");
  });

  test("Given an account whose periodEnd is exactly now competing with an upcoming expiry, When selecting, Then only the strictly upcoming account is tier 0", async () => {
    const { pool } = await setupPool([
      account({ id: "exact", credits: credits(BASE) }),
      account({ id: "soon", credits: credits(BASE + 1 * HOUR) }),
    ]);

    expect((await pool.next(BASE)).id).toBe("soon");
    await pool.quarantine("soon", BASE + 60_000);
    expect((await pool.next(BASE)).id).toBe("exact");
  });

  test("Given an account whose periodEnd is within the expiry window and a preceding plain account, When selecting, Then the upcoming account is tier 0", async () => {
    const { pool } = await setupPool([
      account({ id: "plain" }),
      account({ id: "soon", credits: credits(BASE + 1 * HOUR) }),
    ]);

    expect((await pool.next(BASE)).id).toBe("soon");
  });

  test("Given free-only credits (monthly 0, free > 0) inside the window, When selecting, Then the account is tier 0 eligible", async () => {
    const { pool } = await setupPool([
      account({ id: "plain" }),
      account({
        id: "freeOnly",
        credits: { monthly: 0, purchased: 0, free: 20, periodEnd: BASE + 1 * HOUR },
      }),
    ]);

    expect((await pool.next(BASE)).id).toBe("freeOnly");
  });

  test("Given a session bound while its neighbour is excluded, When the exclusion is lifted, Then the binding stays sticky against tier order", async () => {
    const { pool } = await setupPool([
      account({ id: "early", credits: credits(BASE + 1 * HOUR) }),
      account({ id: "late", credits: credits(BASE + 2 * HOUR) }),
    ]);

    const first = await pool.next(BASE, { sessionId: "s1", excluded: new Set(["early"]) });
    expect(first.id).toBe("late");

    const second = await pool.next(BASE + 1_000, { sessionId: "s1" });
    expect(second.id).toBe("late");

    const other = await pool.next(BASE + 2_000, { sessionId: "s2" });
    expect(other.id).toBe("early");
  });

  test("Given a session bound to a tier-0 account, When that lease is quarantined like a 429, Then the session unbinds, retryAt persists, and the next selection returns the other account", async () => {
    const { pool, clock, path } = await setupPool([
      account({ id: "a" }),
      account({ id: "b", credits: credits(BASE + 2 * HOUR) }),
    ]);

    const lease = await pool.next(BASE, { sessionId: "s1" });
    expect(lease.id).toBe("b");

    await lease.quarantine(clock.now() + 60_000);
    const raw = await readRawAccounts(path);
    expect(raw).toMatchObject({
      version: 1,
      accounts: [{ id: "a" }, { id: "b", retryAt: BASE + 60_000 }],
    });

    const nextLease = await pool.next(BASE + 1_000, { sessionId: "s1" });
    expect(nextLease.id).toBe("a");
  });

  test("Given every account quarantined into the future, When selecting, Then NoHealthyAccountsError carries the minimum future retryAt and its ISO timestamp", async () => {
    const { pool } = await setupPool([account({ id: "a" }), account({ id: "b" })]);
    await pool.quarantine("a", BASE + 5_000);
    await pool.quarantine("b", BASE + 60_000);

    const failure = await nextFailure(pool, BASE);
    expect(failure.retryAt).toBe(BASE + 5_000);
    expect(failure.message).toContain(new Date(BASE + 5_000).toISOString());
  });

  test("Given the fake clock advanced past every cooldown, When selecting again, Then the FIRST account in file order is returned (reset to account 1)", async () => {
    const { pool, clock } = await setupPool([account({ id: "a" }), account({ id: "b" })]);
    await pool.quarantine("a", BASE + 1_000);
    await pool.quarantine("b", BASE + 60_000);
    await expect(pool.next(BASE)).rejects.toBeInstanceOf(NoHealthyAccountsError);

    clock.advance(61_000);
    expect((await pool.next()).id).toBe("a");
    expect((await pool.next(undefined, { sessionId: "fresh" })).id).toBe("a");
  });

  test("Given a disabled account with a stale retryAt, When selecting, Then disabled accounts are never chosen and never mask the empty pool", async () => {
    const { pool } = await setupPool([
      account({ id: "off", enabled: false, retryAt: BASE + 999_999 }),
      account({ id: "on" }),
    ]);
    expect((await pool.next(BASE)).id).toBe("on");

    const { pool: allDisabled } = await setupPool([
      account({ id: "a", enabled: false, retryAt: BASE + 5_000 }),
      account({ id: "b", enabled: false }),
    ]);
    const failure = await nextFailure(allDisabled, BASE);
    expect(failure.retryAt).toBeUndefined();
  });

  test("Given excluded accounts, When selecting with exclusions, Then healthy alternatives are used until the pool empties", async () => {
    const { pool } = await setupPool([account({ id: "a" }), account({ id: "b" })]);
    expect((await pool.next(BASE, { excluded: new Set(["a"]) })).id).toBe("b");
    await expect(pool.next(BASE, { excluded: new Set(["a", "b"]) })).rejects.toBeInstanceOf(
      NoHealthyAccountsError,
    );
  });

  test("Given a bound lease, When unbind() is called, Then the next selection for that session follows tier order afresh", async () => {
    const { pool } = await setupPool([
      account({ id: "early", credits: credits(BASE + 1 * HOUR) }),
      account({ id: "late", credits: credits(BASE + 2 * HOUR) }),
    ]);

    const lease = await pool.next(BASE, { sessionId: "s1", excluded: new Set(["early"]) });
    expect(lease.id).toBe("late");

    lease.unbind();
    expect((await pool.next(BASE, { sessionId: "s1" })).id).toBe("early");
  });

  test("Given an already-quarantined account, When quarantining again with earlier and later times, Then retryAt keeps the maximum", async () => {
    const { pool, path } = await setupPool([account({ id: "a" }), account({ id: "b" })]);

    await pool.quarantine("b", BASE + 60_000);
    await pool.quarantine("b", BASE + 10_000);
    expect(await readRawAccounts(path)).toMatchObject({
      accounts: [{ id: "a" }, { id: "b", retryAt: BASE + 60_000 }],
    });

    await pool.quarantine("b", BASE + 120_000);
    expect(await readRawAccounts(path)).toMatchObject({
      accounts: [{ id: "a" }, { id: "b", retryAt: BASE + 120_000 }],
    });
  });

  test("Given purchased-only credits inside the window, When selecting, Then the account stays tier 1 because monthly+free is zero", async () => {
    const { pool } = await setupPool([
      account({
        id: "purchasedOnly",
        credits: { monthly: 0, purchased: 9, free: 0, periodEnd: BASE + 1 * HOUR },
      }),
      account({ id: "monthly", credits: credits(BASE + 2 * HOUR) }),
      account({ id: "plain" }),
    ]);

    expect((await pool.next(BASE)).id).toBe("monthly");
    await pool.quarantine("monthly", BASE + 60_000);
    expect((await pool.next(BASE)).id).toBe("purchasedOnly");
  });

  test("Given credits just outside the default expiry window, When a custom window is configured, Then the account enters tier 0", async () => {
    const { store, clock } = await setupPool([
      account({ id: "plain" }),
      account({ id: "sub", credits: credits(BASE + 25 * HOUR) }),
    ]);

    const defaultWindow = new AccountPool({ store, now: clock.now, expiryWindowMs: DEFAULT_EXPIRY_WINDOW_MS });
    expect((await defaultWindow.next(BASE)).id).toBe("plain");

    const wideWindow = new AccountPool({ store, now: clock.now, expiryWindowMs: 26 * HOUR });
    expect((await wideWindow.next(BASE)).id).toBe("sub");
  });
});
