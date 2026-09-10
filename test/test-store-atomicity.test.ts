import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, test } from "vitest";
import {
  AccountStoreError,
  AccountStoreJournalWarning,
  parseAccountFile,
} from "../extensions/commandcode/accounts/schema.js";
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
  readonly operation?: { readonly baseLastAppliedSeq?: number };
  readonly transformCalls?: number;
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
    kill(): void;
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
        } catch (error) {
          void error;
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

  function spawnStoreChild(
    accountsPath: string,
    id: string,
    mode?: string,
    action?: string,
    token?: string,
    value?: string,
  ): ManagedChild {
    const fixture = fileURLToPath(new URL("./fixtures/pausable-store-child.mjs", import.meta.url));
    const optional = [mode, action, token, value].filter(
      (argument): argument is string => argument !== undefined,
    );
    const args = [fixture, accountsPath, id, ...optional];
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
    return {
      stdin,
      onceExited,
      kill: () => {
        child.kill("SIGKILL");
      },
      waitForMessage: (type) => waitForMessage(reader, type),
    };
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
      // No lock-file machinery or abandoned temp files; the fully
      // garbage-collected journal has also been removed.
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
    "Given writer A pauses after final identity verification, When B commits before A renames, Then journal reconciliation restores BOTH accounts",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");

      const first = spawnStoreChild(path, "a", "pause-after-verify");
      await first.waitForMessage("held-after-verify");
      expect((await stat(`${path}.journal`)).mode & 0o777).toBe(0o600);
      const second = spawnStoreChild(path, "b");
      await expect(second.onceExited).resolves.toBe(0);

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["a", "b"]);
    },
    30_000,
  );

  test(
    "Given A publishes while B holds a verified stale identity, When C commits before B resumes, Then reconciliation preserves a, b, AND c",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");

      const first = spawnStoreChild(path, "a", "pause-after-write");
      await first.waitForMessage("held-after-write");
      const second = spawnStoreChild(path, "b", "pause-after-verify");
      await second.waitForMessage("held-after-verify");

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);
      const third = spawnStoreChild(path, "c");
      await expect(third.onceExited).resolves.toBe(0);

      second.stdin.end("resume\n");
      await expect(second.onceExited).resolves.toBe(0);
      const ids = await persistedIds(path);
      expect([...ids].sort()).toEqual(["a", "b", "c"]);
    },
    30_000,
  );

  test(
    "Given GC pauses before collecting a settled prefix, When a peer appends a higher-sequence operation and GC resumes, Then the appended operation survives", async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const collector = spawnStoreChild(path, "a", "pause-before-gc");
      await collector.waitForMessage("held-before-gc");
      const writer = spawnStoreChild(path, "b", "pause-after-op");
      await writer.waitForMessage("held-after-op");

      collector.stdin.end("resume\n");
      await expect(collector.onceExited).resolves.toBe(0);
      writer.stdin.end("resume\n");
      await expect(writer.onceExited).resolves.toBe(0);

      await expect(persistedIds(path)).resolves.toEqual(["a", "b"]);
    },
    30_000,
  );

  test(
    "Given a loader pauses after verifying a reconciliation compact, When two writers commit before its stale rename, Then replay restores both commits", async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const first = spawnStoreChild(path, "a", "pause-after-op");
      await first.waitForMessage("held-after-op");
      const loader = spawnStoreChild(path, "loader", "pause-after-verify", "load");
      await loader.waitForMessage("held-after-verify");

      first.stdin.end("resume\n");
      await expect(first.onceExited).resolves.toBe(0);
      const second = spawnStoreChild(path, "b");
      await expect(second.onceExited).resolves.toBe(0);
      loader.stdin.end("resume\n");
      await expect(loader.onceExited).resolves.toBe(0);

      expect([...(await persistedIds(path))].sort()).toEqual(["a", "b"]);
    },
    30_000,
  );

  test("Given a torn journal tail, When another mutation appends, Then writer-side framing preserves the new operation", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const store = new AccountStore({ path, onWarning: () => undefined });
    await store.add(account("a"));
    await writeFile(`${path}.journal`, '{"type":"op"', { mode: 0o600 });

    await store.add(account("b"));

    expect((await store.load()).map((record) => record.id)).toEqual(["a", "b"]);
  });

  test("Given an arbitrary transform changes membership while toggling enabled, When it persists, Then it uses a compact and a true no-op writes no journal", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const store = new AccountStore({ path });
    await store.add(account("a"));
    await store.add(account("b"));

    await store.mutate((records) =>
      records.map((record) =>
        record.id === "a"
          ? { ...record, enabled: false }
          : { ...record, id: "c", token: "token-c" },
      ),
    );
    expect((await store.load()).map((record) => record.id)).toEqual(["a", "c"]);
    await store.mutate((records) => records.map((record) => ({ ...record })));
    await expect(stat(`${path}.journal`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("Given a missing store beneath a nonexistent parent, When it loads, Then it returns empty without creating the parent", async () => {
    const dir = await tempDir();
    const parent = join(dir, "not-created");
    const path = join(parent, "accounts.json");

    await expect(new AccountStore({ path }).load()).resolves.toEqual([]);
    await expect(stat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test(
    "Given an add pauses before append, When a peer commits the same token under another id, Then the stale add rejects instead of reporting false success", async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const first = spawnStoreChild(
        path,
        "a",
        "pause-before-op",
        "add",
        "shared-token",
      );
      await first.waitForMessage("held-before-op");
      const second = spawnStoreChild(path, "b", "normal", "add", "shared-token");
      await expect(second.onceExited).resolves.toBe(0);

      first.stdin.end("resume\n");
      const failure = await first.waitForMessage("error");
      expect(failure.name).toBe("AccountStoreError");
      expect(failure.message).toBe("Account credential already exists");
      await expect(first.onceExited).resolves.toBe(1);
      await expect(persistedIds(path)).resolves.toEqual(["b"]);
    },
    30_000,
  );

  test(
    "Given a loader is paused before appending a stale compact while GC empties the journal, When that compact is appended later, Then its reset sequence cannot replay over newer data",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "watermark.json");
      await new AccountStore({ path }).add(account("seed"));

      const pending = spawnStoreChild(path, "p", "pause-after-op");
      await pending.waitForMessage("held-after-op");
      const loader = spawnStoreChild(
        path,
        "loader",
        "pause-before-state,pause-after-state",
        "load",
      );
      const stale = await loader.waitForMessage("held-before-state");
      expect(stale.operation?.baseLastAppliedSeq).toBeGreaterThan(1);

      pending.stdin.end("resume\n");
      await expect(pending.onceExited).resolves.toBe(0);
      const peer = spawnStoreChild(path, "b");
      await expect(peer.onceExited).resolves.toBe(0);
      await expect(stat(`${path}.journal`)).rejects.toMatchObject({ code: "ENOENT" });

      loader.stdin.write("resume\n");
      await loader.waitForMessage("held-after-state");
      await expect(persistedIds(path)).resolves.toEqual(["seed", "p", "b"]);
      loader.stdin.end("resume\n");
      await expect(loader.onceExited).resolves.toBe(0);
      expect([...(await persistedIds(path))].sort()).toEqual(["b", "p", "seed"]);
    },
    30_000,
  );

  test.each([
    ["increment", 1, true],
    ["toggle", 0, false],
    ["saturate", 1, true],
  ])(
    "Given a non-idempotent %s transform pauses before append, When an unrelated peer add finishes and it resumes, Then it applies exactly once to fresh state and succeeds",
    async (action, expectedMonthly, expectedEnabled) => {
      const dir = await tempDir();
      const path = join(dir, `arbitrary-${action}.json`);
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-before-op", action);
      await mutation.waitForMessage("held-before-op");

      const peer = spawnStoreChild(path, "b");
      await expect(peer.onceExited).resolves.toBe(0);
      mutation.stdin.end("resume\n");
      const persisted = await mutation.waitForMessage("persisted");
      await expect(mutation.onceExited).resolves.toBe(0);

      const records = await new AccountStore({ path }).load();
      expect(records.map((record) => record.id)).toEqual(["a", "b"]);
      expect(records[0]?.credits?.monthly).toBe(expectedMonthly);
      expect(records[0]?.enabled).toBe(expectedEnabled);
      expect(persisted.transformCalls).toBe(2);
    },
    30_000,
  );

  test(
    "Given a state mutation is skipped as older than a peer compact, When publication reconciles, Then the mutation retries until its keyName effect is present",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "state-effect.json");
      await new AccountStore({ path }).add(account("a"));

      const mutation = spawnStoreChild(
        path,
        "a",
        "pause-before-op",
        "state",
        "token-a",
        "requested",
      );
      await mutation.waitForMessage("held-before-op");
      const peer = spawnStoreChild(path, "b", "pause-after-op");
      await peer.waitForMessage("held-after-op");

      mutation.stdin.end("resume\n");
      await expect(mutation.onceExited).resolves.toBe(0);
      peer.stdin.end("resume\n");
      await expect(peer.onceExited).resolves.toBe(0);
      const records = await new AccountStore({ path }).load();
      expect(records.find((record) => record.id === "a")?.keyName).toBe("requested");
    },
    30_000,
  );

  test.each([
    ["retryAt", 100, 200],
    ["createdAt", "2023-11-14T22:13:20.000Z", "2024-11-14T22:13:20.000Z"],
  ])(
    "Given racers add the same id and token with different %s fields, When the stale add resumes, Then it rejects rather than accepting the peer's value",
    async (field, firstValue, secondValue) => {
      const dir = await tempDir();
      const path = join(dir, `same-credential-${field}.json`);
      const base = { id: "a", token: "shared", createdAt: "2023-11-14T22:13:20.000Z" };
      const firstInput = JSON.stringify({ ...base, [field]: firstValue });
      const secondInput = JSON.stringify({ ...base, [field]: secondValue });
      const first = spawnStoreChild(
        path,
        "a",
        "pause-before-op",
        "add-json",
        "unused",
        firstInput,
      );
      await first.waitForMessage("held-before-op");
      const second = spawnStoreChild(path, "a", "normal", "add-json", "unused", secondInput);
      await expect(second.onceExited).resolves.toBe(0);

      first.stdin.end("resume\n");
      await expect(first.waitForMessage("error")).resolves.toMatchObject({
        name: "AccountStoreError",
        message: "Account credential already exists",
      });
      await expect(first.onceExited).resolves.toBe(1);
    },
    30_000,
  );

  test(
    "Given an uncontended add supplies credits in noncanonical property order, When the record is parsed and verified, Then value equality accepts it",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "credits-order.json");
      const input = JSON.stringify({
        id: "a",
        token: "token-a",
        credits: { monthly: 1, free: 0, purchased: 0, periodEnd: 200 },
      });
      const child = spawnStoreChild(path, "a", "normal", "add-json", "unused", input);

      await expect(child.onceExited).resolves.toBe(0);
      await expect(new AccountStore({ path }).load()).resolves.toMatchObject([
        { id: "a", credits: { monthly: 1, purchased: 0, free: 0, periodEnd: 200 } },
      ]);
    },
    30_000,
  );

  test(
    "Given racers add the same id and token with different keyName fields, When both publish, Then exactly one succeeds and the other rejects the credential mismatch",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "same-credential.json");
      const first = spawnStoreChild(
        path,
        "a",
        "pause-before-op",
        "add",
        "shared",
        "first",
      );
      await first.waitForMessage("held-before-op");
      const second = spawnStoreChild(path, "a", "normal", "add", "shared", "second");
      await expect(second.onceExited).resolves.toBe(0);

      first.stdin.end("resume\n");
      const failure = await first.waitForMessage("error");
      expect(failure).toMatchObject({
        name: "AccountStoreError",
        message: "Account credential already exists",
      });
      await expect(first.onceExited).resolves.toBe(1);
      await expect(new AccountStore({ path }).load()).resolves.toMatchObject([
        { id: "a", token: "shared", keyName: "second" },
      ]);
    },
    30_000,
  );

  test(
    "Given a child is killed while owning the journal lock, When a fresh writer steals the stale lock, Then it succeeds without losing its append",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "dead-lock.json");
      const owner = spawnStoreChild(path, "owner", "pause-with-lock");
      await owner.waitForMessage("held-with-lock");
      owner.kill();
      await expect(owner.onceExited).rejects.toThrow(/SIGKILL/);

      const writer = spawnStoreChild(path, "survivor", "steal-lock-now");
      await expect(writer.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["survivor"]);
    },
    30_000,
  );

  test(
    "Given a settled journal prefix is followed by an abandoned operation, When GC runs, Then it collects the prefix without deleting the later pending append",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "prefix-gc.json");
      const collector = spawnStoreChild(path, "settled", "pause-before-gc");
      await collector.waitForMessage("held-before-gc");
      const abandoned = spawnStoreChild(path, "pending", "pause-after-op");
      await abandoned.waitForMessage("held-after-op");
      abandoned.kill();
      await expect(abandoned.onceExited).rejects.toThrow(/SIGKILL/);

      collector.stdin.end("resume\n");
      await expect(collector.onceExited).resolves.toBe(0);
      const retained = (await readFile(`${path}.journal`, "utf-8"))
        .split("\n")
        .filter((line) => line.length > 0);
      expect(retained).toHaveLength(1);
      await expect(persistedIds(path)).resolves.toEqual(["settled", "pending"]);
    },
    30_000,
  );

  test(
    "Given sequential operations fully reconcile, When the mutation returns, Then journal GC leaves an empty protected journal",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const store = new AccountStore({ path });

      await store.add(account("a"));
      await store.setEnabled("a", false);
      await store.remove("a");

      await expect(stat(`${path}.journal`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test(
    "Given a journal ends with a torn garbage line, When load reconciles it, Then load succeeds and reports a typed warning",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const warnings: AccountStoreJournalWarning[] = [];
      const store = new AccountStore({ path, onWarning: (warning) => warnings.push(warning) });
      await store.add(account("a"));
      await writeFile(`${path}.journal`, '{"type":"op"', { encoding: "utf-8", flag: "a" });

      const records = await store.load();

      expect(records.map((record) => record.id)).toEqual(["a"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toBeInstanceOf(AccountStoreJournalWarning);
    },
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

      // No successful account write landed and every attempt cleaned up; the
      // aborted operation and its journal were fully GC'd.
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
