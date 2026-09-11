import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountStoreError,
  parseAccountFile,
  serializeAccountFile,
} from "../extensions/commandcode/accounts/schema.js";
import {
  AccountPool,
  DEFAULT_EXPIRY_WINDOW_MS,
  NoCommandCodeAccountsError,
  resolveExpiryWindowMs,
} from "../extensions/commandcode/accounts/pool.js";
import { AccountStore, resolveAccountsFilePath } from "../extensions/commandcode/accounts/store.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function store(): Promise<AccountStore> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-accounts-"));
  directories.push(dir);
  return new AccountStore({ path: join(dir, "accounts.json"), now: () => NOW });
}

const entry = (id: string, token = `token-${id}`): Record<string, unknown> => ({
  id,
  token,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("account schema", () => {
  it("parses defaults and optional metadata", () => {
    expect(parseAccountFile({
      version: 1,
      accounts: [{
        ...entry("a"),
        userId: "u1",
        userName: "Ada",
        keyName: "laptop",
        credits: { monthly: 1, purchased: 2, free: 3, periodEnd: NOW + HOUR },
      }],
    }).accounts[0]).toEqual({
      id: "a",
      token: "token-a",
      userId: "u1",
      userName: "Ada",
      keyName: "laptop",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      credits: { monthly: 1, purchased: 2, free: 3, periodEnd: NOW + HOUR },
    });
  });

  it.each([
    [[], /JSON object/],
    [{ version: 2, accounts: [] }, /version 1/],
    [{ version: 1, accounts: {} }, /accounts.*array/],
    [{ version: 1, accounts: [42] }, /entry.*object/],
    [{ version: 1, accounts: [{ token: "t", createdAt: "2026-01-01T00:00:00Z" }] }, /id/],
    [{ version: 1, accounts: [{ id: "a", createdAt: "2026-01-01T00:00:00Z" }] }, /token/],
  ])("rejects malformed payload %#", (payload, expected) => {
    expect(() => parseAccountFile(payload)).toThrow(AccountStoreError);
    expect(() => parseAccountFile(payload)).toThrow(expected);
  });

  it("rejects duplicate ids and tokens without leaking token contents", () => {
    expect(() => parseAccountFile({ version: 1, accounts: [entry("a"), entry("a", "other")] }))
      .toThrow(/Duplicate account id/);
    const attempt = (): unknown => parseAccountFile({
      version: 1,
      accounts: [entry("a", "secret-value"), entry("b", "secret-value")],
    });
    expect(attempt).toThrow(/Duplicate account token/);
    try {
      attempt();
    } catch (error: unknown) {
      expect(error instanceof Error ? error.message : "").not.toContain("secret-value");
    }
  });

  it("accepts legacy state fields, retaining credits as a hint and dropping obsolete state", () => {
    const parsed = parseAccountFile({
      version: 1,
      lastAppliedSeq: 99,
      dispositions: [{ ignored: true }],
      accounts: [{
        ...entry("a"),
        retryAt: NOW + HOUR,
        credits: { monthly: 4, purchased: 0, free: 1, periodEnd: NOW + HOUR },
      }],
    });
    expect(parsed.accounts[0]?.credits?.monthly).toBe(4);
    expect(serializeAccountFile(parsed.accounts)).not.toContain("retry" + "At");
    expect(serializeAccountFile(parsed.accounts)).not.toContain("lastAppliedSeq");
  });
});

describe("account ordering", () => {
  it("orders upcoming usable monthly/free credits first by period end, then file order", async () => {
    const accountStore = await store();
    await accountStore.add({ id: "plain", token: "plain" });
    await accountStore.add({
      id: "late",
      token: "late",
      credits: { monthly: 1, purchased: 0, free: 0, periodEnd: NOW + 2 * HOUR },
    });
    await accountStore.add({
      id: "soon",
      token: "soon",
      credits: { monthly: 0, purchased: 0, free: 1, periodEnd: NOW + HOUR },
    });
    await accountStore.add({
      id: "purchased",
      token: "purchased",
      credits: { monthly: 0, purchased: 9, free: 0, periodEnd: NOW + HOUR },
    });
    const pool = new AccountPool({ store: accountStore, now: () => NOW });

    expect((await pool.ordered()).map((account) => account.id)).toEqual([
      "soon", "late", "plain", "purchased",
    ]);
  });

  it("uses a read-only in-memory billing overlay without changing the file", async () => {
    const accountStore = await store();
    await accountStore.add({ id: "plain", token: "plain" });
    await accountStore.add({ id: "soon", token: "soon" });
    const pool = new AccountPool({ store: accountStore, now: () => NOW });
    pool.updateCredits("soon", { monthly: 1, purchased: 0, free: 0, periodEnd: NOW + HOUR });

    expect((await pool.ordered()).map((account) => account.id)).toEqual(["soon", "plain"]);
    expect((await accountStore.load()).find((account) => account.id === "soon")?.credits)
      .toBeUndefined();
  });

  it("ignores disabled accounts and throws a typed error when none remain", async () => {
    const accountStore = await store();
    await accountStore.add({ id: "off", token: "off", enabled: false });
    const pool = new AccountPool({ store: accountStore });
    await expect(pool.ordered()).rejects.toBeInstanceOf(NoCommandCodeAccountsError);
  });
});

describe("configuration", () => {
  it("resolves accounts paths and expiry windows", () => {
    expect(resolveAccountsFilePath({ COMMANDCODE_ACCOUNTS_FILE: "/tmp/accounts.json" }))
      .toBe("/tmp/accounts.json");
    expect(resolveAccountsFilePath({})).toBe(join(homedir(), ".commandcode", "omo-accounts.json"));
    expect(resolveExpiryWindowMs({})).toBe(DEFAULT_EXPIRY_WINDOW_MS);
    expect(resolveExpiryWindowMs({ COMMANDCODE_EXPIRY_WINDOW_MS: "3600000" })).toBe(HOUR);
    expect(() => resolveExpiryWindowMs({ COMMANDCODE_EXPIRY_WINDOW_MS: "no" }))
      .toThrow(AccountStoreError);
  });

  it("loads an explicitly written legacy file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commandcode-legacy-"));
    directories.push(dir);
    const path = join(dir, "accounts.json");
    await writeFile(path, JSON.stringify({ version: 1, accounts: [entry("a")] }));
    await expect(new AccountStore({ path }).load()).resolves.toHaveLength(1);
  });
});
