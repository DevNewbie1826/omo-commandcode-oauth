import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStoreError } from "../extensions/commandcode/accounts/schema.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";

const NOW = 1_700_000_000_000;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(): Promise<{ readonly path: string; readonly store: AccountStore }> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-store-"));
  directories.push(dir);
  const path = join(dir, "nested", "accounts.json");
  return { path, store: new AccountStore({ path, now: () => NOW }) };
}

type ChildMessage = {
  readonly type: "ready" | "starting" | "contended" | "rename" | "done" | "failed" | "zombie" | "reaped";
  readonly id: string;
  readonly name?: string;
  readonly message?: string;
};

function nextMessage(child: ChildProcess, type: ChildMessage["type"]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 10_000);
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== type && message.type !== "failed") return;
      cleanup();
      if (message.type === "failed") reject(new Error(message.message));
      else resolve(message);
    };
    const onExit = (code: number | null): void => { cleanup(); reject(new Error(`Store child exited ${code}`)); };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function nextOutcome(child: ChildProcess): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out waiting for child outcome")); }, 10_000);
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== "rename" && message.type !== "failed") return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null): void => { cleanup(); reject(new Error(`Store child exited ${code}`)); };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function buildStoreChild(path: string, id: string): Promise<string> {
  const directory = join(path, "..", "children");
  await mkdir(directory, { recursive: true });
  const outfile = join(directory, `store-child-${id}.mjs`);
  await build({ entryPoints: [join(import.meta.dirname, "../test-support/store-child.ts")], bundle: true, platform: "node", format: "esm", outfile });
  return outfile;
}

async function spawnStoreChild(path: string, id: string): Promise<ChildProcess> {
  const outfile = await buildStoreChild(path, id);
  const child = fork(outfile, { env: { ...process.env, STORE_PATH: path, ACCOUNT_ID: id }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await nextMessage(child, "ready");
  return child;
}

function lineInbox(child: ChildProcess): { next(type: ChildMessage["type"]): Promise<ChildMessage> } {
  const queued: ChildMessage[] = [];
  const waiters: Array<{
    readonly type: ChildMessage["type"];
    readonly resolve: (message: ChildMessage) => void;
    readonly reject: (cause: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const message = JSON.parse(line) as ChildMessage;
    const index = waiters.findIndex((waiter) => waiter.type === message.type || message.type === "failed");
    if (index < 0) queued.push(message);
    else {
      const waiter = waiters.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      if (message.type === "failed") waiter.reject(new Error(message.message));
      else waiter.resolve(message);
    }
  });
  child.once("exit", (code) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`Zombie parent exited ${code}`));
    }
  });
  return {
    next(type) {
      const index = queued.findIndex((message) => message.type === type || message.type === "failed");
      if (index >= 0) {
        const message = queued.splice(index, 1)[0]!;
        return message.type === "failed" ? Promise.reject(new Error(message.message)) : Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 10_000);
        waiters.push({ type, resolve, reject, timer });
      });
    },
  };
}

const ZOMBIE_PARENT = String.raw`
import os, signal, subprocess, sys
dead = False
def child_exited(_signal, _frame):
  global dead
  dead = True
signal.signal(signal.SIGCHLD, child_exited)
child = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=subprocess.PIPE,
  stdout=subprocess.PIPE, text=True, env=os.environ)
print(child.stdout.readline(), end="", flush=True)
for command in sys.stdin:
  command = command.strip()
  if command == "start":
    child.stdin.write("start\n"); child.stdin.flush()
    print(child.stdout.readline(), end="", flush=True)
    print(child.stdout.readline(), end="", flush=True)
  elif command == "kill":
    os.kill(child.pid, signal.SIGKILL)
    while not dead:
      signal.pause()
    print('{"type":"zombie","id":"zombie"}', flush=True)
  elif command == "reap":
    child.wait()
    print('{"type":"reaped","id":"zombie"}', flush=True)
    break
`;

describe("AccountStore management writes", () => {
  it("performs CRUD with canonical reloads", async () => {
    const { path, store } = await setup();
    await store.add({ id: "a", token: "token-a" });
    await store.add({ id: "b", token: "token-b" });
    await store.setEnabled("b", false);
    await store.remove("a");

    await expect(new AccountStore({ path }).load()).resolves.toMatchObject([
      { id: "b", token: "token-b", enabled: false },
    ]);
    await expect(store.remove("missing")).rejects.toThrow(AccountStoreError);
    await expect(store.setEnabled("missing", true)).rejects.toThrow(AccountStoreError);
  });

  it("serializes concurrent adds from independent store instances", async () => {
    const { path } = await setup();
    const first = new AccountStore({ path, now: () => NOW });
    const second = new AccountStore({ path, now: () => NOW });

    await Promise.all([
      first.add({ id: "a", token: "token-a" }),
      second.add({ id: "b", token: "token-b" }),
    ]);

    expect((await new AccountStore({ path }).load()).map((account) => account.id).sort())
      .toEqual(["a", "b"]);
  });

  it.each([["a", "b"], ["b", "a"]] as const)(
    "preserves fresh-owner adds published in %s/%s order",
    async (firstId, secondId) => {
      const { path, store } = await setup();
      await store.add({ id: "seed", token: "token-seed" });
      const children = {
        a: await spawnStoreChild(path, "a"),
        b: await spawnStoreChild(path, "b"),
      };
      const first = children[firstId];
      const second = children[secondId];
      const firstRename = nextMessage(first, "rename");
      first.send("start");
      await firstRename;
      const secondContended = nextMessage(second, "contended");
      second.send("start");
      await secondContended;

      const firstDone = nextMessage(first, "done");
      first.send("release");
      await firstDone;
      await nextMessage(second, "rename");
      const secondDone = nextMessage(second, "done");
      second.send("release");
      await secondDone;

      expect((await new AccountStore({ path }).load()).map((account) => account.id))
        .toEqual(["seed", firstId, secondId]);
    },
  );

  it("never loses an acknowledged add when a live lock owner is aged", async () => {
    const { path, store } = await setup();
    await store.add({ id: "seed", token: "token-seed" });
    const [a, b] = await Promise.all([spawnStoreChild(path, "a"), spawnStoreChild(path, "b")]);
    const aRename = nextMessage(a, "rename");
    a.send("start");
    await aRename;
    expect(a.pid).toBeTypeOf("number");
    expect(() => process.kill(a.pid!, 0)).not.toThrow();

    const bOutcome = nextOutcome(b);
    const bContended = nextMessage(b, "contended");
    b.send({ start: true, nowOffset: 31_000 });
    await bContended;
    const outcome = await bOutcome;
    const acknowledged = ["seed"];
    if (outcome.type === "rename") {
      const bDone = nextMessage(b, "done");
      b.send("release");
      await bDone;
      acknowledged.push("b");
      expect((await new AccountStore({ path }).load()).map((account) => account.id))
        .toEqual(["seed", "b"]);
    } else {
      expect(outcome).toMatchObject({ name: "AccountStoreError" });
    }

    const aDone = nextMessage(a, "done");
    a.send("release");
    await aDone;
    acknowledged.push("a");
    await store.add({ id: "later", token: "token-later" });
    acknowledged.push("later");
    const finalIds = (await new AccountStore({ path }).load()).map((account) => account.id);
    for (const id of acknowledged) expect(finalIds).toContain(id);
  });

  it("lets an aged contender publish after the live owner publishes first", async () => {
    const { path, store } = await setup();
    await store.add({ id: "seed", token: "token-seed" });
    const [a, b] = await Promise.all([spawnStoreChild(path, "a"), spawnStoreChild(path, "b")]);
    const aRename = nextMessage(a, "rename");
    a.send("start");
    await aRename;
    const bContended = nextMessage(b, "contended");
    b.send({ start: true, nowOffset: 31_000 });
    await bContended;

    const aDone = nextMessage(a, "done");
    a.send("release");
    await aDone;
    await nextMessage(b, "rename");
    const bDone = nextMessage(b, "done");
    b.send("release");
    await bDone;
    await store.add({ id: "later", token: "token-later" });

    expect((await new AccountStore({ path }).load()).map((account) => account.id))
      .toEqual(["seed", "a", "b", "later"]);
  });

  it.each([["b", "c"], ["c", "b"]] as const)(
    "preserves every acknowledged add after a killed owner in %s/%s order",
    async (firstId, secondId) => {
      const { path, store } = await setup();
      await store.add({ id: "seed", token: "token-seed" });
      const [dead, b, c] = await Promise.all([
        spawnStoreChild(path, "dead"),
        spawnStoreChild(path, "b"),
        spawnStoreChild(path, "c"),
      ]);
      const children = { b, c };
      const deadRename = nextMessage(dead, "rename");
      dead.send("start");
      await deadRename;

      const first = children[firstId];
      const second = children[secondId];
      const firstContended = nextMessage(first, "contended");
      first.send("start");
      await firstContended;
      const secondContended = nextMessage(second, "contended");
      second.send("start");
      await secondContended;

      expect(second.pid).toBeTypeOf("number");
      process.kill(second.pid!, "SIGSTOP");
      const exited = new Promise((resolve) => dead.once("exit", resolve));
      dead.kill("SIGKILL");
      await exited;
      await nextMessage(first, "rename");

      const firstDone = nextMessage(first, "done");
      first.send("release");
      await firstDone;
      process.kill(second.pid!, "SIGCONT");
      await nextMessage(second, "rename");
      const secondDone = nextMessage(second, "done");
      second.send("release");
      await secondDone;

      expect((await new AccountStore({ path }).load()).map((account) => account.id))
        .toEqual(["seed", firstId, secondId]);
      expect((await readdir(join(path, ".."))).filter((name) => /lock|socket|sock/i.test(name)))
        .toEqual([]);
    },
  );

  it("recovers immediately after a killed owner without filesystem lock cleanup", async () => {
    const { path } = await setup();
    const child = await spawnStoreChild(path, "killed");
    const reachedRename = nextMessage(child, "rename");
    child.send("start");
    await reachedRename;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;

    await expect(new AccountStore({ path }).add({ id: "recovered", token: "token-recovered" }))
      .resolves.toBeUndefined();
    expect((await readdir(join(path, ".."))).filter((name) => /lock|socket|sock/i.test(name)))
      .toEqual([]);
  });

  it("uses kernel death, not reaping, to recover from a zombie owner", async () => {
    const { path } = await setup();
    const outfile = await buildStoreChild(path, "zombie");
    const parent = spawn("python3", ["-u", "-c", ZOMBIE_PARENT, process.execPath, outfile], {
      env: { ...process.env, STORE_PATH: path, ACCOUNT_ID: "zombie" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const inbox = lineInbox(parent);
    await inbox.next("ready");
    parent.stdin!.write("start\n");
    await inbox.next("rename");
    parent.stdin!.write("kill\n");
    // SIGCHLD was consumed without wait(): the dead Node owner is still a zombie here.
    await inbox.next("zombie");

    await expect(new AccountStore({ path }).add({ id: "after-zombie", token: "token-after-zombie" }))
      .resolves.toBeUndefined();
    expect((await new AccountStore({ path }).load()).map((account) => account.id))
      .toEqual(["after-zombie"]);

    const exited = new Promise((resolve) => parent.once("exit", resolve));
    parent.stdin!.write("reap\n");
    await inbox.next("reaped");
    await exited;
    expect((await readdir(join(path, ".."))).filter((name) => /lock|socket|sock/i.test(name)))
      .toEqual([]);
  }, 15_000);

  it("rejects duplicate ids and credentials without changing the file", async () => {
    const { path, store } = await setup();
    await store.add({ id: "a", token: "shared" });
    const before = await readFile(path);

    await expect(store.add({ id: "a", token: "other" })).rejects.toThrow(/id already exists/);
    await expect(store.add({ id: "b", token: "shared" })).rejects.toThrow(/credential already exists/);
    expect(await readFile(path)).toEqual(before);
  });

  it("publishes mode 0600 by atomic replacement and leaves no temporary files", async () => {
    const { path, store } = await setup();
    await store.add({ id: "a", token: "token-a" });
    const firstInode = (await stat(path)).ino;
    await store.setEnabled("a", false);
    const secondStats = await stat(path);

    expect(secondStats.mode & 0o777).toBe(0o600);
    expect(secondStats.ino).not.toBe(firstInode);
    expect(await readdir(join(path, ".."))).toEqual(["accounts.json"]);
  });

  it("loads legacy files and removes obsolete fields on the next management write", async () => {
    const { path, store } = await setup();
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      lastAppliedSeq: 12,
      accounts: [{
        id: "legacy",
        token: "token-legacy",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        retryAt: NOW + 60_000,
        credits: { monthly: 1, purchased: 0, free: 0, periodEnd: NOW + 60_000 },
      }],
    }));

    expect((await store.load())[0]?.credits?.monthly).toBe(1);
    await store.setEnabled("legacy", false);
    const contents = await readFile(path, "utf-8");
    expect(contents).not.toContain("retry" + "At");
    expect(contents).not.toContain("lastAppliedSeq");
    expect(contents).toContain('"credits"');
  });
});
