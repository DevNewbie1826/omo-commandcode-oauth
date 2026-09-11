import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  readonly type: "ready" | "rename" | "done" | "failed";
  readonly id: string;
  readonly name?: string;
  readonly message?: string;
};

function nextMessage(child: ChildProcess, type: ChildMessage["type"]): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== type && message.type !== "failed") return;
      cleanup();
      if (message.type === "failed") reject(new Error(message.message));
      else resolve(message);
    };
    const onExit = (code: number | null): void => { cleanup(); reject(new Error(`Store child exited ${code}`)); };
    const cleanup = (): void => { child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function nextOutcome(child: ChildProcess): Promise<ChildMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: ChildMessage): void => {
      if (message.type !== "rename" && message.type !== "failed") return;
      cleanup();
      resolve(message);
    };
    const onExit = (code: number | null): void => { cleanup(); reject(new Error(`Store child exited ${code}`)); };
    const cleanup = (): void => { child.off("message", onMessage); child.off("exit", onExit); };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

async function spawnStoreChild(path: string, id: string): Promise<ChildProcess> {
  const directory = join(path, "..", "children");
  await mkdir(directory, { recursive: true });
  const outfile = join(directory, `store-child-${id}.mjs`);
  await build({ entryPoints: [join(import.meta.dirname, "../test-support/store-child.ts")], bundle: true, platform: "node", format: "esm", outfile });
  const child = fork(outfile, { env: { ...process.env, STORE_PATH: path, ACCOUNT_ID: id }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await nextMessage(child, "ready");
  return child;
}

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

  it("preserves both acknowledged adds from IPC-gated Node processes", async () => {
    const { path, store } = await setup();
    await store.add({ id: "seed", token: "token-seed" });
    const [a, b] = await Promise.all([spawnStoreChild(path, "a"), spawnStoreChild(path, "b")]);
    const aRename = nextMessage(a, "rename");
    const bRename = nextMessage(b, "rename");
    a.send("start");
    b.send("start");
    const first = await Promise.race([aRename, bRename]);
    const firstChild = first.id === "a" ? a : b;
    const secondChild = first.id === "a" ? b : a;
    const lockExists = await stat(`${path}.lock`).then(() => true, () => false);
    if (!lockExists) await (first.id === "a" ? bRename : aRename);
    const firstDone = nextMessage(firstChild, "done");
    firstChild.send("release");
    await firstDone;
    if (lockExists) await (first.id === "a" ? bRename : aRename);
    const secondDone = nextMessage(secondChild, "done");
    secondChild.send("release");
    await secondDone;

    expect((await new AccountStore({ path }).load()).map((account) => account.id).sort())
      .toEqual(["a", "b", "seed"]);
  });

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
    b.send({ start: true, nowOffset: 31_000 });
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
    const finalIds = (await new AccountStore({ path }).load()).map((account) => account.id);
    for (const id of acknowledged) expect(finalIds).toContain(id);
  });

  it("recovers an exclusive lock left by a killed owner", async () => {
    const { path } = await setup();
    const child = await spawnStoreChild(path, "killed");
    const reachedRename = nextMessage(child, "rename");
    child.send("start");
    await reachedRename;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    await utimes(`${path}.lock`, new Date(0), new Date(0));

    await expect(new AccountStore({ path }).add({ id: "recovered", token: "token-recovered" }))
      .resolves.toBeUndefined();
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

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
