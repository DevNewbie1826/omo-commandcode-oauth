import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AccountStoreError,
  MAX_EPOCH_MS,
  parseAccountFile,
} from "../extensions/commandcode/accounts/schema.js";
import type { AccountRecord } from "../extensions/commandcode/accounts/schema.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-schema-boundaries-"));
  tempDirs.push(dir);
  return dir;
}

const NOW = 1_700_000_000_000;

function fileWith(accounts: readonly unknown[]): string {
  return JSON.stringify({ version: 1, accounts });
}

function recordWith(overrides: Partial<AccountRecord>): AccountRecord {
  return {
    id: "a",
    token: "token-a",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("load boundary: persisted timestamps", () => {
  test("Given a persisted account whose retryAt is null, When loading, Then the load rejects with an AccountStoreError naming retryAt", async () => {
    const path = join(await tempDir(), "accounts.json");
    await writeFile(path, fileWith([{ id: "a", token: "t", createdAt: "2026-01-01T00:00:00.000Z", retryAt: null }]), "utf-8");

    const store = new AccountStore({ path });

    await expect(store.load()).rejects.toThrow(AccountStoreError);
    await expect(store.load()).rejects.toThrow(/"retryAt"/);
  });

  test("Given persisted retryAt values outside [0, 8.64e15] or non-integral, When loading, Then every one rejects with an AccountStoreError naming retryAt", async () => {
    for (const retryAt of [1e308, MAX_EPOCH_MS + 1, -1, 1.5]) {
      const path = join(await tempDir(), "accounts.json");
      await writeFile(path, fileWith([{ id: "a", token: "t", createdAt: "2026-01-01T00:00:00.000Z", retryAt }]), "utf-8");

      const store = new AccountStore({ path });

      await expect(store.load()).rejects.toThrow(AccountStoreError);
      await expect(store.load()).rejects.toThrow(/"retryAt"/);
    }
  });

  test("Given a persisted credits.periodEnd outside [0, 8.64e15] or null, When loading, Then the load rejects with an AccountStoreError naming credits.periodEnd", async () => {
    for (const periodEnd of [1e308, MAX_EPOCH_MS + 1, -1, null]) {
      const path = join(await tempDir(), "accounts.json");
      await writeFile(
        path,
        fileWith([
          {
            id: "a",
            token: "t",
            createdAt: "2026-01-01T00:00:00.000Z",
            credits: { monthly: 1, purchased: 0, free: 0, periodEnd },
          },
        ]),
        "utf-8",
      );

      const store = new AccountStore({ path });

      await expect(store.load()).rejects.toThrow(AccountStoreError);
      await expect(store.load()).rejects.toThrow(/"credits\.periodEnd"/);
    }
  });

  test("Given a persisted far-future retryAt and periodEnd at the maximum representable epoch, When loading, Then the load succeeds with those values", async () => {
    const path = join(await tempDir(), "accounts.json");
    await writeFile(
      path,
      fileWith([
        {
          id: "a",
          token: "t",
          createdAt: "2026-01-01T00:00:00.000Z",
          retryAt: MAX_EPOCH_MS,
          credits: { monthly: 1, purchased: 0, free: 0, periodEnd: MAX_EPOCH_MS },
        },
      ]),
      "utf-8",
    );

    const store = new AccountStore({ path });

    const records = await store.load();
    expect(records.map((record) => record.retryAt)).toEqual([MAX_EPOCH_MS]);
    expect(records.map((record) => record.credits?.periodEnd)).toEqual([MAX_EPOCH_MS]);
  });

  test("Given a raw payload with an out-of-range retryAt, When parsing directly, Then the error is an AccountStoreError naming retryAt", () => {
    const caught = (() => {
      try {
        parseAccountFile(JSON.parse(fileWith([{ id: "a", token: "t", createdAt: "2026-01-01T00:00:00.000Z", retryAt: 1e308 }])));
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(caught).toBeInstanceOf(AccountStoreError);
    expect(caught).toMatchObject({ message: expect.stringMatching(/"retryAt"/) });
  });
});

describe("write boundary: serialization refusal", () => {
  test("Given a persisted good state, When a mutate injects a record with an out-of-range retryAt, Then the store throws AccountStoreError and the file is byte-for-byte unchanged", async () => {
    const path = join(await tempDir(), "accounts.json");
    const store = new AccountStore({ path, now: () => NOW });
    await store.add({ id: "a", token: "token-a" });
    const before = await readFile(path, "utf-8");

    const invalid: AccountRecord = recordWith({ id: "bad", token: "token-bad", retryAt: 1e308 });
    await expect(store.mutate((records) => [...records, invalid])).rejects.toThrow(AccountStoreError);
    await expect(store.mutate((records) => [...records, invalid])).rejects.toThrow(/retryAt/);

    expect(await readFile(path, "utf-8")).toBe(before);
    expect(store.accounts().map((record) => record.id)).toEqual(["a"]);
    const persisted = await new AccountStore({ path }).load();
    expect(persisted.map((record) => record.id)).toEqual(["a"]);
  });

  test("Given a persisted good state, When a mutate injects a record whose credits.periodEnd is Infinity (the JSON.stringify null hazard), Then the store throws AccountStoreError and the file is unchanged", async () => {
    const path = join(await tempDir(), "accounts.json");
    const store = new AccountStore({ path, now: () => NOW });
    await store.add({ id: "a", token: "token-a" });
    const before = await readFile(path, "utf-8");

    const invalid: AccountRecord = recordWith({
      id: "bad",
      token: "token-bad",
      credits: { monthly: 1, purchased: 0, free: 0, periodEnd: Infinity },
    });
    await expect(store.mutate((records) => [...records, invalid])).rejects.toThrow(AccountStoreError);
    await expect(store.mutate((records) => [...records, invalid])).rejects.toThrow(/periodEnd/);

    expect(await readFile(path, "utf-8")).toBe(before);
    const persisted = await new AccountStore({ path }).load();
    expect(persisted.map((record) => record.id)).toEqual(["a"]);
  });

  test("Given a persisted good state, When add is called with an out-of-range retryAt on the input, Then the store throws AccountStoreError and the file is unchanged", async () => {
    const path = join(await tempDir(), "accounts.json");
    const store = new AccountStore({ path, now: () => NOW });
    await store.add({ id: "a", token: "token-a" });
    const before = await readFile(path, "utf-8");

    await expect(store.add({ id: "b", token: "token-b", retryAt: MAX_EPOCH_MS + 1 })).rejects.toThrow(
      AccountStoreError,
    );

    expect(await readFile(path, "utf-8")).toBe(before);
  });

  test("Given a store whose file does not exist yet, When add is called with an invalid retryAt, Then no accounts file is created", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const store = new AccountStore({ path, now: () => NOW });

    await expect(store.add({ id: "a", token: "token-a", retryAt: -5 })).rejects.toThrow(AccountStoreError);

    await expect(stat(path)).rejects.toThrow();
  });
});
