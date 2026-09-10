import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
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

/** One JSON protocol line from the pausable-store child fixture. */
interface ChildMessage {
  readonly type: string;
  readonly ids?: readonly string[];
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

describe("cross-process lock ownership", () => {
  interface ManagedChild {
    readonly stdin: NodeJS.WritableStream;
    readonly onceExited: Promise<number>;
    waitForMessage(type: string): Promise<ChildMessage>;
  }

  function isChildMessage(value: unknown): value is ChildMessage {
    return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
  }

  function waitForMessage(reader: ReadlineInterface, type: string): Promise<ChildMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reader.off("line", onLine);
        reject(new Error(`child never reported "${type}"`));
      }, 20_000);
      const onLine = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return; // not a protocol line; keep waiting
        }
        if (!isChildMessage(parsed)) return;
        clearTimeout(timeout);
        reader.off("line", onLine);
        resolve(parsed);
      };
      reader.on("line", onLine);
    });
  }

  function fixtureRuntime(): string {
    // bunx vitest runs tests under node; the fixture imports the TypeScript
    // store source, so it must be executed by bun (which resolves .ts
    // imports and the .js -> .ts specifier mapping).
    const executable = process.execPath;
    return executable.endsWith("bun") ? executable : "bun";
  }

  function spawnStoreChild(accountsPath: string, id: string, mode?: string): ManagedChild {
    const fixture = fileURLToPath(new URL("./fixtures/pausable-store-child.mjs", import.meta.url));
    const args = mode === undefined ? [fixture, accountsPath, id] : [fixture, accountsPath, id, mode];
    const child = spawn(fixtureRuntime(), args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill();
      throw new Error("child process streams unavailable");
    }
    let stderrText = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrText += String(chunk);
    });
    const onceExited = new Promise<number>((resolve, reject) => {
      child.once("exit", (code, signal) => {
        if (code !== null) resolve(code);
        else reject(new Error(`child exited via signal ${String(signal)}; stderr: ${stderrText}`));
      });
    });
    const reader = createInterface({ input: stdout });
    return { stdin, onceExited, waitForMessage: (type) => waitForMessage(reader, type) };
  }

  async function persistedIds(accountsPath: string): Promise<string[]> {
    const records = await new AccountStore({ path: accountsPath }).load();
    return records.map((record) => record.id);
  }

  test(
    "Given owner A locks, reads and pauses while its lock ages out, When B steals the lock, persists and releases, and A resumes, Then A detects the broken ownership, re-runs from the read, and BOTH accounts persist",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const lockPath = `${path}.lock`;

      const first = spawnStoreChild(path, "a", "hold");
      const held = await first.waitForMessage("held-after-read");
      expect(held.ids).toEqual([]);

      // Model the suspended writer's elapsed lease without sleeping: the lock
      // now looks older than LOCK_STALE_MS even though A is still live.
      const aged = new Date(Date.now() - 60_000);
      await utimes(lockPath, aged, aged);

      const second = spawnStoreChild(path, "b");
      await expect(second.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["b"]);

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);

      const ids = await persistedIds(path);
      expect([...ids].sort()).toEqual(["a", "b"]);
      await expect(readdir(dir)).resolves.toEqual(["accounts.json"]);
    },
    30_000,
  );

  test(
    "Given a lock aged beyond the stale threshold naming a dead owner, When a fresh process acquires, Then recovery is prompt (inside the acquire timeout), the add persists, and the lock is cleanly released",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const lockPath = `${path}.lock`;
      await writeFile(lockPath, "999999-dead-owner-token", "utf-8");
      const aged = new Date(Date.now() - 60_000);
      await utimes(lockPath, aged, aged);

      const started = Date.now();
      const child = spawnStoreChild(path, "a");
      const code = await child.onceExited;
      const elapsedMs = Date.now() - started;

      expect(code).toBe(0);
      // A failed stale-break would burn the full 5s acquire timeout instead.
      expect(elapsedMs).toBeLessThan(5_000);
      await expect(persistedIds(path)).resolves.toEqual(["a"]);
      await expect(readdir(dir)).resolves.toEqual(["accounts.json"]);
    },
    30_000,
  );
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
