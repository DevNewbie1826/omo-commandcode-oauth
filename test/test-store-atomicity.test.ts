import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  readonly name?: string;
  readonly message?: string;
}

function caughtOf(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    return error;
  }
}

describe("cross-process atomicity", () => {
  test("Given two stores on one path that both load before either writes, When each adds a different account concurrently, Then BOTH accounts persist because the identity compare-and-rename serializes the read-modify-write", async () => {
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

describe("cross-process optimistic concurrency", () => {
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
        if (!isChildMessage(parsed) || parsed.type !== type) return;
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
    "Given writer A pauses after capturing the file identity and reading, When writer B persists in that window and A resumes, Then A detects the identity conflict, retries from a fresh read, and BOTH accounts persist with no lock or temp residue",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");

      const first = spawnStoreChild(path, "a", "pause-after-read");
      const held = await first.waitForMessage("held-after-read");
      expect(held.ids).toEqual([]);

      const second = spawnStoreChild(path, "b");
      await expect(second.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["b"]);

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);

      const ids = await persistedIds(path);
      expect([...ids].sort()).toEqual(["a", "b"]);
      // No lock-file machinery, no abandoned temp files: the mutation cycle
      // leaves exactly the accounts file behind.
      await expect(readdir(dir)).resolves.toEqual(["accounts.json"]);
    },
    30_000,
  );

  test(
    "Given three writers interleaved across processes — A paused mid-cycle while B and C persist concurrently — When A resumes, Then all three accounts persist",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");

      const first = spawnStoreChild(path, "a", "pause-after-read");
      const held = await first.waitForMessage("held-after-read");
      expect(held.ids).toEqual([]);

      // Barrier-sequenced interleaving: B's full mutation cycle completes
      // while A is parked, then C runs against B's replaced file. Sequencing
      // through process-exit barriers (never sleeps) keeps the schedule
      // deterministic; each writer must still survive on a file identity its
      // initial read never saw.
      const second = spawnStoreChild(path, "b");
      await expect(second.onceExited).resolves.toBe(0);
      const third = spawnStoreChild(path, "c");
      await expect(third.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["b", "c"]);

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);

      const ids = await persistedIds(path);
      expect([...ids].sort()).toEqual(["a", "b", "c"]);
      await expect(readdir(dir)).resolves.toEqual(["accounts.json"]);
    },
    30_000,
  );

  test(
    "Given writer A pauses after reading, When the file is externally replaced with a different valid store file and A resumes, Then A's stale write never silently overwrites the replacement — the identity conflict forces a retry that keeps both",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const externalAccount = {
        id: "ext",
        token: "token-ext",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      const first = spawnStoreChild(path, "a", "pause-after-read");
      const held = await first.waitForMessage("held-after-read");
      expect(held.ids).toEqual([]);

      // Replace the file OUTSIDE any store, between A's read and its
      // verify-and-rename: a content A has never seen.
      const external = `${JSON.stringify({ version: 1, accounts: [externalAccount] }, null, 2)}\n`;
      await writeFile(path, external, "utf-8");

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);

      const ids = await persistedIds(path);
      expect([...ids].sort()).toEqual(["a", "ext"]);
      // The externally-written credential survived A's stale write attempt.
      const finalContents = await readFile(path, "utf-8");
      expect(finalContents).toContain("token-ext");
      await expect(readdir(dir)).resolves.toEqual(["accounts.json"]);
    },
    30_000,
  );

  test(
    "Given every optimistic-concurrency verification is forced to fail, When a writer exhausts its bounded attempts, Then it fails with a typed concurrent-modification error and leaves no temp or lock residue",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");

      const child = spawnStoreChild(path, "a", "conflict-forever");
      const failure = await child.waitForMessage("error");
      expect(failure.name).toBe("AccountStoreError");
      expect(failure.message).toMatch(/concurrent/i);
      await expect(child.onceExited).resolves.toBe(1);

      // No successful write ever landed and every attempt cleaned up: the
      // directory holds neither the accounts file nor temp/lock residue.
      await expect(readdir(dir)).resolves.toEqual([]);
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
