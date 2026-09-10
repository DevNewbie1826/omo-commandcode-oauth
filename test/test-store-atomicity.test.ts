import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AccountStoreError, parseAccountFile } from "../extensions/commandcode/accounts/schema.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";
import type { AccountRecordInput } from "../extensions/commandcode/accounts/schema.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-store-atomicity-"));
  tempDirs.push(dir);
  return dir;
}

function account(id: string, token: string = `token-${id}`): AccountRecordInput {
  return { id, token };
}

function caughtOf(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    return error;
  }
}

describe("cross-process atomicity", () => {
  test("Given two stores on one path that both load before either writes, When each adds a different account concurrently, Then BOTH accounts persist because the file lock serializes the read-modify-write", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const first = new AccountStore({ path });
    const second = new AccountStore({ path });
    await Promise.all([first.load(), second.load()]);

    await Promise.all([first.add(account("a")), second.add(account("b"))]);

    const persisted = await new AccountStore({ path }).load();
    expect(persisted.map((record) => record.id).sort()).toEqual(["a", "b"]);
  });

  test("Given a stale 0644 temp file planted at the legacy predictable temp name, When a store persists, Then the credential file still lands with mode 0600 and the planted file is never reused", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const legacyTemp = `${path}.${process.pid}.tmp`;
    await writeFile(legacyTemp, "stale", "utf-8");
    await chmod(legacyTemp, 0o644);

    const store = new AccountStore({ path });
    await store.add(account("a"));

    const persisted = await stat(path);
    expect(persisted.mode & 0o777).toBe(0o600);
    const planted = await stat(legacyTemp);
    expect(planted.mode & 0o777).toBe(0o644);
    await expect(readFile(legacyTemp, "utf-8")).resolves.toBe("stale");
    expect((await readdir(dir)).sort()).toEqual(
      ["accounts.json", `accounts.json.${process.pid}.tmp`].sort(),
    );
    const records = await new AccountStore({ path }).load();
    expect(records.map((record) => record.id)).toEqual(["a"]);
  });

  test("Given a lock file stale beyond the break threshold, When another store persists, Then the stale lock is broken and the add succeeds without waiting out the timeout", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "", "utf-8");
    const staleMoment = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleMoment, staleMoment);

    const store = new AccountStore({ path });
    await store.add(account("a"));

    const records = await new AccountStore({ path }).load();
    expect(records.map((record) => record.id)).toEqual(["a"]);
    await expect(readdir(dir)).resolves.toEqual(["accounts.json"]);
  });

  test("Given the accounts path sits beneath a plain file, When a store persists, Then the failure throws AccountStoreError and leaves the blocking file intact", async () => {
    const dir = await tempDir();
    const blocker = join(dir, "blocker");
    const blockerContents = "not a directory";
    await writeFile(blocker, blockerContents, "utf-8");
    const path = join(blocker, "accounts.json");

    const store = new AccountStore({ path });
    await expect(store.add(account("a"))).rejects.toThrow(AccountStoreError);

    const blockerStats = await stat(blocker);
    expect(blockerStats.isFile()).toBe(true);
    await expect(readFile(blocker, "utf-8")).resolves.toBe(blockerContents);
  });
});

describe("duplicate-token error hygiene", () => {
  test("Given two entries sharing a token, When parsing, Then the error names the duplicate account id and never echoes any token content", () => {
    const token = "super-secret-token-value-9f2c";
    const payload = {
      version: 1,
      accounts: [
        { id: "first", token, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "second", token, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    };

    const error = caughtOf(() => parseAccountFile(payload));
    if (!(error instanceof AccountStoreError)) {
      throw new Error(`expected AccountStoreError, received ${String(error)}`);
    }
    expect(error.message).toMatch(/Duplicate account token \(account id: second\)/);
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain(token.slice(-4));
  });
});
