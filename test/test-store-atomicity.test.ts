import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
