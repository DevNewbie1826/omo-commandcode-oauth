import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Interface as ReadlineInterface } from "node:readline";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, test } from "vitest";
import {
  AccountStoreError,
  AccountStoreJournalWarning,
  parseAccountFile,
  parseAccountOperationDisposition,
} from "../extensions/commandcode/accounts/schema.js";
import { AccountPool } from "../extensions/commandcode/accounts/pool.js";
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

async function journalLines(accountsPath: string): Promise<string[]> {
  const journalName = `${basename(accountsPath)}.journal`;
  const names = (await readdir(dirname(accountsPath)))
    .filter((name) => name === journalName || name.startsWith(`${journalName}.archive-`));
  const contents = await Promise.all(
    names.map((name) => readFile(join(dirname(accountsPath), name), "utf-8")),
  );
  return contents.flatMap((content) => content.split("\n").filter((line) => line.length > 0));
}

async function expectNoTransientResidue(directory: string): Promise<void> {
  const transient = (await readdir(directory)).filter(
    (name) =>
      name.endsWith(".lock") ||
      name.endsWith(".tmp") ||
      name.endsWith(".stale") ||
      name.endsWith(".claim"),
  );
  expect(transient).toEqual([]);
}

/** One JSON protocol line from the pausable-store child fixture. */
interface ChildMessage {
  readonly type: string;
  readonly ids?: readonly string[];
  readonly name?: string;
  readonly message?: string;
  readonly operation?: {
    readonly baseLastAppliedSeq?: number;
    readonly baseRecords?: readonly { readonly id: string; readonly enabled: boolean }[];
  };
  readonly candidates?: readonly unknown[];
  readonly transformCalls?: number;
  readonly inode?: number;
  readonly nlink?: number;
  readonly seq?: number;
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
    const files = await readdir(dir);
    expect(files).toContain("accounts.json");
    expect(files).toContain(`accounts.json.${process.pid}.tmp`);
    expect(files.filter((name) => name.endsWith(".lock"))).toEqual([]);
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
    signal(signal: NodeJS.Signals): void;
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
      signal: (signal) => {
        child.kill(signal);
      },
      waitForMessage: (type) => waitForMessage(reader, type),
    };
  }

  async function persistedIds(accountsPath: string): Promise<string[]> {
    const records = await new AccountStore({ path: accountsPath }).load();
    return records.map((record) => record.id);
  }

  async function raceCollectedVersionScan(
    path: string,
    action: "load" | "enable",
  ): Promise<ChildMessage> {
    const mirrorOwner = spawnStoreChild(path, "a", "pause-before-mirror");
    await mirrorOwner.waitForMessage("held-before-mirror");
    mirrorOwner.signal("SIGSTOP");

    const disable = spawnStoreChild(path, "a", "normal", "enable", "unused", "false");
    await expect(disable.onceExited).resolves.toBe(0);
    for (const id of ["c", "d"]) {
      const peer = spawnStoreChild(path, id);
      await expect(peer.onceExited).resolves.toBe(0);
    }

    const target = spawnStoreChild(
      path,
      "a",
      "pause-after-version-scan",
      action,
      "unused",
      action === "enable" ? "true" : undefined,
    );
    const scan = await target.waitForMessage("held-after-version-scan");
    expect(scan.candidates).toHaveLength(3);
    target.signal("SIGSTOP");

    for (const id of ["e", "f", "g"]) {
      const peer = spawnStoreChild(path, id);
      await expect(peer.onceExited).resolves.toBe(0);
    }

    const mirrorDone = mirrorOwner.waitForMessage("persisted");
    mirrorOwner.signal("SIGCONT");
    mirrorOwner.stdin.end("resume\n");
    await expect(mirrorDone).resolves.toMatchObject({ type: "persisted" });
    await expect(mirrorOwner.onceExited).resolves.toBe(0);

    const targetDone = target.waitForMessage("persisted");
    target.signal("SIGCONT");
    target.stdin.end("resume\n");
    const result = await targetDone;
    await expect(target.onceExited).resolves.toBe(0);
    return result;
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
      // Rotation may retain bounded journal archives, but no lock or
      // temporary publication artifact survives the completed mutation.
      await expectNoTransientResidue(dir);
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
      await expectNoTransientResidue(dir);
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
      await expectNoTransientResidue(dir);
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
    "Given an ordinary publisher is parked at its final identity boundary, When four acknowledged peers publish and collect before it resumes, Then its stale version cannot erase any account and a later add also survives",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "five-writer-version-fence.json");
      const parked = spawnStoreChild(path, "a", "pause-after-verify");
      await parked.waitForMessage("held-after-verify");
      parked.signal("SIGSTOP");

      for (const id of ["b", "c", "d", "e"]) {
        const peer = spawnStoreChild(path, id);
        await expect(peer.onceExited).resolves.toBe(0);
        await expect(persistedIds(path)).resolves.toEqual([
          "a",
          ...["b", "c", "d", "e"].slice(0, ["b", "c", "d", "e"].indexOf(id) + 1),
        ]);
      }

      parked.signal("SIGCONT");
      parked.stdin.end("resume\n");
      await expect(parked.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["a", "b", "c", "d", "e"]);

      await new AccountStore({ path }).add(account("later"));
      await expect(persistedIds(path)).resolves.toEqual(["a", "b", "c", "d", "e", "later"]);
    },
    30_000,
  );

  test(
    "Given a setter's complete version scan is collected and the mirror regresses, When selection resumes, Then it never acknowledges a no-op from the mirror",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "collected-scan-setter.json");

      const setter = await raceCollectedVersionScan(path, "enable");

      expect(setter.ids).toEqual(["a", "c", "d", "e", "f", "g"]);
      const records = await new AccountStore({ path }).load();
      expect(records.find((record) => record.id === "a")?.enabled).toBe(true);
    },
    30_000,
  );

  test(
    "Given acknowledged records predate a load whose complete version scan is collected, When a stale mirror lands before selection resumes, Then load never returns the mirror's pre-invocation state",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "collected-scan-load.json");

      const loaded = await raceCollectedVersionScan(path, "load");

      expect(loaded.ids).toEqual(["a", "c", "d", "e", "f", "g"]);
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

  test("Given settled mutations and a torn disposition tail, When another mutation publishes, Then durable opId outcomes remain parseable, framed, and mode 0600", async () => {
    const dir = await tempDir();
    const path = join(dir, "disposition-framing.json");
    const store = new AccountStore({ path, onWarning: () => undefined });
    await store.add(account("a"));
    const dispositionsPath = `${path}.dispositions`;
    const firstContents = await readFile(dispositionsPath, "utf-8");
    const firstLines = firstContents.split("\n").filter((line) => line.length > 0);
    expect(firstLines.map((line) => parseAccountOperationDisposition(JSON.parse(line)))).not.toHaveLength(0);
    expect((await stat(dispositionsPath)).mode & 0o777).toBe(0o600);

    await writeFile(dispositionsPath, '{"opId":', { encoding: "utf-8", flag: "a" });
    await store.setEnabled("a", false);

    const framed = await readFile(dispositionsPath, "utf-8");
    const lines = framed.split("\n").filter((line) => line.length > 0);
    const tornIndex = lines.indexOf('{"opId":');
    expect(tornIndex).toBeGreaterThanOrEqual(0);
    const last = lines.at(-1);
    if (last === undefined || tornIndex === lines.length - 1) {
      throw new Error("missing disposition after torn tail");
    }
    expect(parseAccountOperationDisposition(JSON.parse(last))).toMatchObject({
      outcome: "applied",
    });
  });

  test("Given a torn journal tail, When another mutation appends, Then writer-side framing preserves the new operation", async () => {
    const dir = await tempDir();
    const path = join(dir, "accounts.json");
    const store = new AccountStore({ path, onWarning: () => undefined });
    await store.add(account("a"));
    await writeFile(`${path}.journal`, '{"type":"op"', { mode: 0o600 });

    await store.add(account("b"));

    expect((await store.load()).map((record) => record.id)).toEqual(["a", "b"]);
  });

  test(
    "Given an add overlaps an order-only mutation, When the mutation reverses file order, Then pool selection and later writes preserve the reordered accounts",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "order-only-mutation.json");
      const seed = new AccountStore({ path });
      await seed.add(account("a"));
      await seed.add(account("b"));

      const pendingAdd = spawnStoreChild(path, "c", "pause-before-op");
      await pendingAdd.waitForMessage("held-before-op");

      let transformCalls = 0;
      await new AccountStore({ path }).mutate((records) => {
        transformCalls += 1;
        return [...records].reverse();
      });
      expect(transformCalls).toBe(1);
      await expect(persistedIds(path)).resolves.toEqual(["b", "a"]);
      const reorderedSelection = await new AccountPool({
        store: new AccountStore({ path }),
      }).next();
      expect(reorderedSelection.id).toBe("b");

      const addPersisted = pendingAdd.waitForMessage("persisted");
      pendingAdd.stdin.end("resume\n");
      await expect(addPersisted).resolves.toMatchObject({ ids: ["b", "a", "c"] });
      await expect(pendingAdd.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["b", "a", "c"]);

      await new AccountStore({ path }).setEnabled("c", false);
      const finalStore = new AccountStore({ path });
      await expect(finalStore.load()).resolves.toMatchObject([
        { id: "b", enabled: true },
        { id: "a", enabled: true },
        { id: "c", enabled: false },
      ]);
      const finalSelection = await new AccountPool({ store: finalStore }).next();
      expect(finalSelection.id).toBe("b");
    },
    30_000,
  );

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
    const beforeNoOp = await journalLines(path);
    await store.mutate((records) => records.map((record) => ({ ...record })));
    expect(await journalLines(path)).toEqual(beforeNoOp);
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
    "Given a stale state operation is settled as skipped before its owner loses publication, When the owner completes, Then it retries from fresh state instead of acknowledging the skipped increment",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "skipped-state-disposition.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(
        path,
        "a",
        "pause-before-op,pause-after-verify",
        "increment",
      );
      await mutation.waitForMessage("held-before-op");
      await expect(spawnStoreChild(path, "b").onceExited).resolves.toBe(0);

      const heldVerify = mutation.waitForMessage("held-after-verify");
      mutation.stdin.write("resume\n");
      await heldVerify;
      await expect(spawnStoreChild(path, "c").onceExited).resolves.toBe(0);

      const persisted = mutation.waitForMessage("persisted");
      mutation.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 2 });
      await expect(mutation.onceExited).resolves.toBe(0);
      const records = await new AccountStore({ path }).load();
      expect(records.map((record) => record.id)).toEqual(["a", "b", "c"]);
      expect(records[0]?.credits?.monthly).toBe(1);
    },
    30_000,
  );

  test(
    "Given a duplicate add is settled as rejected before its owner loses publication, When the owner completes, Then it throws credential-exists instead of acknowledging another account",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "rejected-add-disposition.json");
      const mutation = spawnStoreChild(
        path,
        "a",
        "pause-before-op,pause-after-verify",
        "add",
        "shared-token",
      );
      await mutation.waitForMessage("held-before-op");
      await expect(
        spawnStoreChild(path, "b", "normal", "add", "shared-token").onceExited,
      ).resolves.toBe(0);

      const heldVerify = mutation.waitForMessage("held-after-verify");
      mutation.stdin.write("resume\n");
      await heldVerify;
      await expect(spawnStoreChild(path, "c").onceExited).resolves.toBe(0);

      const failure = mutation.waitForMessage("error");
      mutation.stdin.end("resume\n");
      await expect(failure).resolves.toMatchObject({
        name: "AccountStoreError",
        message: "Account credential already exists",
      });
      await expect(mutation.onceExited).resolves.toBe(1);
      await expect(persistedIds(path)).resolves.toEqual(["b", "c"]);
    },
    30_000,
  );

  test(
    "Given an operation append completes on a journal inode collected during stale-lease recovery, When its owner loses publication, Then missing disposition evidence retries the transform exactly once",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "unlinked-append-disposition.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(
        path,
        "a",
        "pause-before-append-file,pause-after-verify,short-stale-lock",
        "increment",
      );
      await mutation.waitForMessage("held-before-append-file");
      mutation.signal("SIGSTOP");
      await expect(spawnStoreChild(path, "b", "short-stale-lock").onceExited).resolves.toBe(0);

      const resumedAppend = mutation.waitForMessage("append-file-resumed");
      const heldVerify = mutation.waitForMessage("held-after-verify");
      mutation.signal("SIGCONT");
      mutation.stdin.write("resume\n");
      await expect(resumedAppend).resolves.toMatchObject({ nlink: 0 });
      await heldVerify;
      mutation.signal("SIGSTOP");
      await expect(spawnStoreChild(path, "c", "short-stale-lock").onceExited).resolves.toBe(0);

      const persisted = mutation.waitForMessage("persisted");
      mutation.signal("SIGCONT");
      mutation.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 2 });
      await expect(mutation.onceExited).resolves.toBe(0);
      const records = await new AccountStore({ path }).load();
      expect(records.map((record) => record.id)).toEqual(["a", "b", "c"]);
      expect(records[0]?.credits?.monthly).toBe(1);
    },
    30_000,
  );

  test(
    "Given a peer applies a multi-leaf operation before its owner first replays, When the owner resumes, Then its applied disposition prevents a second transform",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "absorbed-before-owner-replay-disposition.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-after-op", "multi");
      await mutation.waitForMessage("held-after-op");
      await expect(
        spawnStoreChild(path, "a", "normal", "enable", "unused", "true").onceExited,
      ).resolves.toBe(0);

      const persisted = mutation.waitForMessage("persisted");
      mutation.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 1 });
      await expect(mutation.onceExited).resolves.toBe(0);
      const [record] = await new AccountStore({ path }).load();
      expect(record?.credits).toMatchObject({ monthly: 1, purchased: 1 });
    },
    30_000,
  );

  test.each(["killed", "live-delayed"] as const)(
    "Given an operation is absorbed by a %s settler paused after linking, When another loader collects recovery bytes and the owner resumes, Then embedded outcomes prevent a second transform",
    async (settlerState) => {
      const dir = await tempDir();
      const path = join(dir, `${settlerState}-atomic-disposition.json`);
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });

      const owner = spawnStoreChild(path, "a", "pause-after-op", "increment");
      await owner.waitForMessage("held-after-op");
      owner.signal("SIGSTOP");

      const settler = spawnStoreChild(path, "loader", "pause-before-mirror", "load");
      await settler.waitForMessage("held-before-mirror");
      if (settlerState === "killed") {
        const killed = settler.onceExited;
        settler.kill();
        await expect(killed).rejects.toThrow(/SIGKILL/);
      } else {
        settler.signal("SIGSTOP");
      }

      await expect(spawnStoreChild(path, "collector", "normal", "load").onceExited).resolves.toBe(0);

      const persisted = owner.waitForMessage("persisted");
      owner.signal("SIGCONT");
      owner.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 1 });
      await expect(owner.onceExited).resolves.toBe(0);

      if (settlerState === "live-delayed") {
        const settled = settler.waitForMessage("persisted");
        settler.signal("SIGCONT");
        settler.stdin.end("resume\n");
        await expect(settled).resolves.toMatchObject({ transformCalls: 0 });
        await expect(settler.onceExited).resolves.toBe(0);
      }

      const [record] = await new AccountStore({ path }).load();
      expect(record?.credits?.monthly).toBe(1);
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
      const loaderPersisted = loader.waitForMessage("persisted");
      loader.stdin.end("resume\n");
      await expect(loaderPersisted).resolves.toMatchObject({ type: "persisted" });
      await expect(loader.onceExited).resolves.toBe(0);
      expect([...(await persistedIds(path))].sort()).toEqual(["b", "p", "seed"]);
    },
    30_000,
  );

  test(
    "Given a pending add is retained in an archive while a loader prepares a compact, When another add appends before that compact, Then archive-aware sequencing preserves both adds",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "archived-sequence-allocation.json");

      const seed = spawnStoreChild(path, "seed", "pause-before-gc");
      await seed.waitForMessage("held-before-gc");
      seed.signal("SIGSTOP");
      const archivedAdd = spawnStoreChild(path, "a", "pause-after-op");
      await archivedAdd.waitForMessage("held-after-op");
      archivedAdd.signal("SIGSTOP");

      const seedPersisted = seed.waitForMessage("persisted");
      seed.signal("SIGCONT");
      seed.stdin.end("resume\n");
      await expect(seedPersisted).resolves.toMatchObject({ type: "persisted" });
      await expect(seed.onceExited).resolves.toBe(0);
      await expect(stat(`${path}.journal`)).rejects.toMatchObject({ code: "ENOENT" });

      const loader = spawnStoreChild(path, "loader", "pause-before-op", "load");
      await loader.waitForMessage("held-before-op");
      loader.signal("SIGSTOP");
      const liveAdd = spawnStoreChild(path, "d", "pause-after-op");
      await liveAdd.waitForMessage("held-after-op");
      liveAdd.signal("SIGSTOP");

      const loaded = loader.waitForMessage("persisted");
      loader.signal("SIGCONT");
      loader.stdin.end("resume\n");
      await expect(loaded).resolves.toMatchObject({ type: "persisted" });
      await expect(loader.onceExited).resolves.toBe(0);

      const livePersisted = liveAdd.waitForMessage("persisted");
      liveAdd.signal("SIGCONT");
      liveAdd.stdin.end("resume\n");
      await expect(livePersisted).resolves.toMatchObject({ type: "persisted" });
      await expect(liveAdd.onceExited).resolves.toBe(0);

      const archivedPersisted = archivedAdd.waitForMessage("persisted");
      archivedAdd.signal("SIGCONT");
      archivedAdd.stdin.end("resume\n");
      await expect(archivedPersisted).resolves.toMatchObject({ type: "persisted" });
      await expect(archivedAdd.onceExited).resolves.toBe(0);

      expect([...(await persistedIds(path))].sort()).toEqual(["a", "d", "seed"]);
    },
    30_000,
  );

  test.each(["enable", "remove", "add"] as const)(
    "Given a live %s allocator holds an exclusive sequence claim before append, When its lease is stolen and a loader prepares a compact from the peer prefix, Then sequences stay unique and the stale compact cannot erase the delayed effect",
    async (action) => {
      const dir = await tempDir();
      const path = join(dir, `claimed-sequence-${action}.json`);
      const seed = new AccountStore({ path });
      await seed.add(account("a"));
      await seed.add(account("b"));

      const delayed = spawnStoreChild(
        path,
        action === "add" ? "d" : "a",
        "pause-before-append-file,pause-after-op,short-stale-lock",
        action,
        action === "add" ? "token-d" : "unused",
        action === "enable" ? "false" : undefined,
      );
      const delayedClaim = await delayed.waitForMessage("held-before-append-file");
      delayed.signal("SIGSTOP");

      const peer = spawnStoreChild(
        path,
        "b",
        "pause-after-op,short-stale-lock",
        "enable",
        "unused",
        "false",
      );
      await peer.waitForMessage("held-after-op");
      const liveEntries = (await journalLines(path)).map((line) => JSON.parse(line) as {
        readonly seq?: number;
        readonly operation?: { readonly id?: string };
      });
      const peerSeq = liveEntries.find((entry) => entry.operation?.id === "b")?.seq;
      expect(delayedClaim.seq).toBeTypeOf("number");
      expect(peerSeq).toBeTypeOf("number");
      expect(peerSeq).not.toBe(delayedClaim.seq);

      const loader = spawnStoreChild(
        path,
        "loader",
        "pause-before-state,short-stale-lock",
        "load",
      );
      await loader.waitForMessage("held-before-state");

      const delayedAppended = delayed.waitForMessage("held-after-op");
      delayed.signal("SIGCONT");
      delayed.stdin.write("resume\n");
      await delayedAppended;

      const loaded = loader.waitForMessage("persisted");
      loader.stdin.end("resume\n");
      await expect(loaded).resolves.toMatchObject({ type: "persisted" });
      await expect(loader.onceExited).resolves.toBe(0);

      const delayedDone = delayed.waitForMessage("persisted");
      delayed.stdin.end("resume\n");
      await expect(delayedDone).resolves.toMatchObject({ type: "persisted" });
      await expect(delayed.onceExited).resolves.toBe(0);

      const peerDone = peer.waitForMessage("persisted");
      peer.stdin.end("resume\n");
      await expect(peerDone).resolves.toMatchObject({ type: "persisted" });
      await expect(peer.onceExited).resolves.toBe(0);

      const final = await new AccountStore({ path }).load();
      expect(final.find((record) => record.id === "b")?.enabled).toBe(false);
      if (action === "enable") expect(final.find((record) => record.id === "a")?.enabled).toBe(false);
      if (action === "remove") expect(final.some((record) => record.id === "a")).toBe(false);
      if (action === "add") expect(final.some((record) => record.id === "d")).toBe(true);
      await expectNoTransientResidue(dir);
    },
    30_000,
  );

  test.each(["enable", "remove", "add"] as const)(
    "Given a live lower-sequence %s is delayed until an unrelated user transform observes a higher sequence, When the delayed operation appends before the transform, Then the transform retries from that actual base and preserves both effects",
    async (action) => {
      const dir = await tempDir();
      const path = join(dir, `claimed-sequence-user-state-${action}.json`);
      const seed = new AccountStore({ path });
      for (const id of ["a", "b"]) {
        await seed.add({
          id,
          token: `token-${id}`,
          credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
        });
      }

      const delayed = spawnStoreChild(
        path,
        action === "add" ? "d" : "a",
        "pause-before-append-file,pause-after-op,short-stale-lock",
        action,
        action === "add" ? "token-d" : "unused",
        action === "enable" ? "false" : undefined,
      );
      const delayedClaim = await delayed.waitForMessage("held-before-append-file");
      delayed.signal("SIGSTOP");

      const peer = spawnStoreChild(
        path,
        "b",
        "pause-after-op,short-stale-lock",
        "enable",
        "unused",
        "false",
      );
      await peer.waitForMessage("held-after-op");
      peer.signal("SIGSTOP");

      const mutation = spawnStoreChild(
        path,
        "b",
        "pause-before-op,short-stale-lock",
        "increment",
      );
      const prepared = await mutation.waitForMessage("held-before-op");
      expect(prepared.operation?.baseRecords?.map((record) => record.id)).toEqual(["a", "b"]);
      expect(prepared.operation?.baseRecords?.find((record) => record.id === "a")?.enabled).toBe(true);
      expect(prepared.operation?.baseRecords?.find((record) => record.id === "b")?.enabled).toBe(false);
      mutation.signal("SIGSTOP");

      const delayedAppended = delayed.waitForMessage("held-after-op");
      delayed.signal("SIGCONT");
      delayed.stdin.write("resume\n");
      await delayedAppended;
      delayed.signal("SIGSTOP");

      const liveEntries = (await journalLines(path)).map((line) => JSON.parse(line) as {
        readonly seq?: number;
        readonly operation?: { readonly id?: string };
      });
      const peerSeq = liveEntries.find((entry) => entry.operation?.id === "b")?.seq;
      expect(delayedClaim.seq).toBeTypeOf("number");
      expect(peerSeq).toBeTypeOf("number");
      expect(peerSeq).not.toBe(delayedClaim.seq);

      const mutationDone = mutation.waitForMessage("persisted");
      mutation.signal("SIGCONT");
      mutation.stdin.end("resume\n");
      await expect(mutationDone).resolves.toMatchObject({ transformCalls: 2 });
      await expect(mutation.onceExited).resolves.toBe(0);

      const delayedDone = delayed.waitForMessage("persisted");
      delayed.signal("SIGCONT");
      delayed.stdin.end("resume\n");
      await expect(delayedDone).resolves.toMatchObject({ type: "persisted" });
      await expect(delayed.onceExited).resolves.toBe(0);

      const peerDone = peer.waitForMessage("persisted");
      peer.signal("SIGCONT");
      peer.stdin.end("resume\n");
      await expect(peerDone).resolves.toMatchObject({ type: "persisted" });
      await expect(peer.onceExited).resolves.toBe(0);

      const final = await new AccountStore({ path }).load();
      expect(final.find((record) => record.id === "b")).toMatchObject({
        enabled: false,
        credits: { monthly: 1 },
      });
      if (action === "enable") expect(final.find((record) => record.id === "a")?.enabled).toBe(false);
      if (action === "remove") expect(final.some((record) => record.id === "a")).toBe(false);
      if (action === "add") expect(final.some((record) => record.id === "d")).toBe(true);

      await new AccountStore({ path }).add(account("later"));
      const afterLaterAdd = await new AccountStore({ path }).load();
      if (action === "enable") {
        expect(afterLaterAdd.find((record) => record.id === "a")?.enabled).toBe(false);
      }
      if (action === "remove") expect(afterLaterAdd.some((record) => record.id === "a")).toBe(false);
      if (action === "add") expect(afterLaterAdd.some((record) => record.id === "d")).toBe(true);
      await expectNoTransientResidue(dir);
    },
    30_000,
  );

  test(
    "Given two same-base increments target the same account, When both are acknowledged, Then the skipped transform retries from fresh state and both increments persist",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "same-target-increments.json");
      const seed = new AccountStore({ path });
      for (const id of ["a", "b"]) {
        await seed.add({
          id,
          token: `token-${id}`,
          credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
        });
      }

      const first = spawnStoreChild(path, "a", "pause-before-op", "increment");
      const second = spawnStoreChild(path, "a", "pause-before-op", "increment");
      await Promise.all([
        first.waitForMessage("held-before-op"),
        second.waitForMessage("held-before-op"),
      ]);

      const firstPersisted = first.waitForMessage("persisted");
      first.stdin.write("resume\n");
      await expect(firstPersisted).resolves.toMatchObject({ transformCalls: 1 });
      await expect(first.onceExited).resolves.toBe(0);

      const secondPersisted = second.waitForMessage("persisted");
      second.stdin.end("resume\n");
      await expect(secondPersisted).resolves.toMatchObject({ transformCalls: 2 });
      await expect(second.onceExited).resolves.toBe(0);

      const final = await new AccountStore({ path }).load();
      expect(final.find((record) => record.id === "a")?.credits?.monthly).toBe(2);
      await new AccountStore({ path }).add(account("later"));
      const retained = await new AccountStore({ path }).load();
      expect(retained.find((record) => record.id === "a")?.credits?.monthly).toBe(2);
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

  test.each([
    ["increment", 1, true],
    ["toggle", 0, false],
    ["saturate", 1, true],
  ])(
    "Given a non-idempotent %s transform has published, When an unrelated peer add lands before verification, Then the published effect is recognized and not applied again",
    async (action, expectedMonthly, expectedEnabled) => {
      const dir = await tempDir();
      const path = join(dir, `post-publication-${action}.json`);
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-after-write", action);
      await mutation.waitForMessage("held-after-write");
      mutation.signal("SIGSTOP");

      const peer = spawnStoreChild(path, "b");
      await expect(peer.onceExited).resolves.toBe(0);
      const persistedMessage = mutation.waitForMessage("persisted");
      mutation.signal("SIGCONT");
      mutation.stdin.end("resume\n");
      await expect(mutation.onceExited).resolves.toBe(0);
      await expect(persistedMessage).resolves.toMatchObject({ transformCalls: 1 });

      const records = await new AccountStore({ path }).load();
      expect(records.map((record) => record.id)).toEqual(["a", "b"]);
      expect(records[0]?.credits?.monthly).toBe(expectedMonthly);
      expect(records[0]?.enabled).toBe(expectedEnabled);
    },
    30_000,
  );

  test(
    "Given a peer absorbs a paused multi-leaf mutation and overwrites one leaf, When the owner loses publication and reconciles, Then the applied disposition prevents double application",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "peer-absorbed-multi-leaf.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-after-verify", "multi");
      await mutation.waitForMessage("held-after-verify");
      mutation.signal("SIGSTOP");

      const peer = spawnStoreChild(path, "a", "normal", "enable", "unused", "true");
      await expect(peer.onceExited).resolves.toBe(0);
      const persisted = mutation.waitForMessage("persisted");
      mutation.signal("SIGCONT");
      mutation.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 1 });
      await expect(mutation.onceExited).resolves.toBe(0);

      const [record] = await new AccountStore({ path }).load();
      expect(record?.enabled).toBe(true);
      expect(record?.credits).toMatchObject({ monthly: 1, purchased: 1 });
    },
    30_000,
  );

  test(
    "Given a monthly increment has published, When a peer changes only credits.free before verification, Then leaf-level verification recognizes the increment without applying it twice",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "credit-leaf-verification.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-after-write", "increment");
      await mutation.waitForMessage("held-after-write");
      mutation.signal("SIGSTOP");

      const peer = spawnStoreChild(path, "a", "normal", "free");
      await expect(peer.onceExited).resolves.toBe(0);
      const persisted = mutation.waitForMessage("persisted");
      mutation.signal("SIGCONT");
      mutation.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 1 });
      await expect(mutation.onceExited).resolves.toBe(0);

      const [record] = await new AccountStore({ path }).load();
      expect(record?.credits).toMatchObject({ monthly: 1, free: 5 });
    },
    30_000,
  );

  test(
    "Given a transform adds new and increments a before publication verification, When a peer disables new, Then existence verifies the add and the independent increment is not repeated",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "added-record-existence-verification.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-after-write", "add-and-increment");
      await mutation.waitForMessage("held-after-write");
      mutation.signal("SIGSTOP");

      const peer = spawnStoreChild(path, "new", "normal", "enable", "unused", "false");
      await expect(peer.onceExited).resolves.toBe(0);
      const persisted = mutation.waitForMessage("persisted");
      mutation.signal("SIGCONT");
      mutation.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ transformCalls: 1 });
      await expect(mutation.onceExited).resolves.toBe(0);

      const records = await new AccountStore({ path }).load();
      expect(records.find((record) => record.id === "a")?.credits?.monthly).toBe(1);
      expect(records.find((record) => record.id === "new")?.enabled).toBe(false);
    },
    30_000,
  );

  test(
    "Given a transform returns credits in a different property order after a genuine stale attempt, When its retry publishes structurally equal values, Then verification succeeds after one logical application",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "reordered-transform-credits.json");
      await new AccountStore({ path }).add({
        id: "a",
        token: "token-a",
        credits: { monthly: 0, purchased: 0, free: 0, periodEnd: 200 },
      });
      const mutation = spawnStoreChild(path, "a", "pause-before-op", "reordered-increment");
      await mutation.waitForMessage("held-before-op");
      const peer = spawnStoreChild(path, "b");
      await expect(peer.onceExited).resolves.toBe(0);

      const persistedMessage = mutation.waitForMessage("persisted");
      mutation.stdin.end("resume\n");
      await expect(mutation.onceExited).resolves.toBe(0);
      await expect(persistedMessage).resolves.toMatchObject({ transformCalls: 2 });
      const records = await new AccountStore({ path }).load();
      expect(records.map((record) => record.id)).toEqual(["a", "b"]);
      expect(records[0]?.credits?.monthly).toBe(1);
    },
    30_000,
  );

  test(
    "Given a state setter pauses before linking and a later setter fully overwrites it, When the first setter resumes, Then it repairs its erased effect without re-running unrelated transform work",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "fully-erased-applied-state.json");
      await new AccountStore({ path }).add(account("a"));

      const first = spawnStoreChild(
        path,
        "a",
        "pause-after-verify",
        "state",
        "token-a",
        "first",
      );
      await first.waitForMessage("held-after-verify");
      const second = spawnStoreChild(path, "a", "normal", "state", "token-a", "second");
      await expect(second.onceExited).resolves.toBe(0);
      expect((await new AccountStore({ path }).load())[0]?.keyName).toBe("second");

      const persisted = first.waitForMessage("persisted");
      first.stdin.end("resume\n");
      await expect(persisted).resolves.toMatchObject({ ids: ["a"], transformCalls: 1 });
      await expect(first.onceExited).resolves.toBe(0);
      const loaded = await new AccountStore({ path }).load();
      expect(loaded[0]?.keyName).toBe("first");
      await expect(new AccountStore({ path }).load()).resolves.toEqual(loaded);
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
    "Given a child is killed while owning the journal lock, When a fresh writer waits for the full default stale threshold, Then it recovers and persists",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "dead-lock.json");
      const owner = spawnStoreChild(path, "owner", "pause-with-lock");
      await owner.waitForMessage("held-with-lock");
      owner.kill();
      await expect(owner.onceExited).rejects.toThrow(/SIGKILL/);

      const writer = spawnStoreChild(path, "survivor");
      await expect(writer.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["survivor"]);
    },
    30_000,
  );

  test(
    "Given a live GC owner is stopped after reading the journal, When a peer steals the elapsed short lease and adds an account before the owner resumes, Then stale GC re-derives and preserves both acknowledged accounts",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "live-owner-gc.json");
      const owner = spawnStoreChild(
        path,
        "a",
        "pause-in-gc-after-journal-read,short-stale-lock",
      );
      await owner.waitForMessage("held-in-gc-after-journal-read");
      owner.signal("SIGSTOP");

      const peer = spawnStoreChild(path, "b", "short-stale-lock");
      await expect(peer.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["a", "b"]);

      owner.signal("SIGCONT");
      owner.stdin.end("resume\n");
      await expect(owner.onceExited).resolves.toBe(0);
      await expect(persistedIds(path)).resolves.toEqual(["a", "b"]);
    },
    30_000,
  );

  test(
    "Given a GC owner reaches the rotation decision and loses its default lease, When a peer commits and collects its journal before the owner resumes, Then GC never regresses the accounts snapshot or watermark",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "gc-rotation-boundary.json");
      const owner = spawnStoreChild(path, "a", "pause-before-gc-rotation");
      await owner.waitForMessage("held-before-gc-rotation");
      const lockBefore = await stat(`${path}.journal.lock`);
      owner.signal("SIGSTOP");

      const peer = spawnStoreChild(path, "b");
      await expect(peer.onceExited).resolves.toBe(0);
      const acknowledged = parseAccountFile(JSON.parse(await readFile(path, "utf-8")));
      expect(acknowledged.accounts.map((record) => record.id)).toEqual(["a", "b"]);
      expect(acknowledged.lastAppliedSeq).toBe(4);
      expect(Date.now() - lockBefore.mtimeMs).toBeGreaterThanOrEqual(15_000);

      owner.signal("SIGCONT");
      owner.stdin.end("resume\n");
      await expect(owner.onceExited).resolves.toBe(0);

      const after = parseAccountFile(JSON.parse(await readFile(path, "utf-8")));
      expect(after.accounts.map((record) => record.id)).toEqual(["a", "b"]);
      expect(after.lastAppliedSeq).toBe(4);
      await expect(persistedIds(path)).resolves.toEqual(["a", "b"]);
    },
    35_000,
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
      const retained = (await journalLines(path)).map((line) => JSON.parse(line) as ChildMessage);
      expect(retained).toContainEqual(expect.objectContaining({ type: "op" }));
      await expect(persistedIds(path)).resolves.toEqual(["settled", "pending"]);
    },
    30_000,
  );

  test(
    "Given sequential operations fully reconcile, When the mutation returns, Then journal GC leaves no live journal and only bounded archives",
    async () => {
      const dir = await tempDir();
      const path = join(dir, "accounts.json");
      const store = new AccountStore({ path });

      await store.add(account("a"));
      await store.setEnabled("a", false);
      await store.remove("a");

      await expect(stat(`${path}.journal`)).rejects.toMatchObject({ code: "ENOENT" });
      const archives = (await readdir(dir)).filter((name) => name.includes(".journal.archive-"));
      expect(archives.length).toBeLessThanOrEqual(2);
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

      // No successful account write landed and every attempt cleaned up its
      // lock and temporary publication artifacts. Rotation may retain the
      // aborted operation in a bounded archive.
      await expectNoTransientResidue(dir);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
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
