import { watch } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { AccountStoreError } from "./schema.js";

const LOCK_WAIT_MS = 2_000;
const LOCK_RECHECK_MS = 25;

interface LockOwner {
  readonly pid: number;
  readonly uuid: string;
  readonly acquiredAt: number;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function waitForChange(path: string, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dirname(path), () => finish());
    const timer = setTimeout(finish, Math.min(waitMs, LOCK_RECHECK_MS));
    function finish(): void {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}

function parseOwner(value: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<LockOwner>;
    if (!Number.isInteger(owner.pid) || (owner.pid ?? 0) <= 0 || typeof owner.uuid !== "string"
      || typeof owner.acquiredAt !== "number") return undefined;
    return owner as LockOwner;
  } catch (_error: unknown) {
    return undefined;
  }
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return codeOf(cause) !== "ESRCH";
  }
}

async function reclaimDeadOwner(path: string, observed: string): Promise<boolean> {
  try {
    if (await readFile(path, "utf-8") !== observed) return false;
    await rm(path);
    return true;
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return true;
    throw new AccountStoreError(`Could not reclaim accounts lock at ${path}`, { cause });
  }
}

async function acquire(path: string, owner: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(owner, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (cause) {
      if (codeOf(cause) !== "EEXIST") {
        throw new AccountStoreError(`Could not acquire accounts lock at ${path}`, { cause });
      }
    }
    try {
      const observed = await readFile(path, "utf-8");
      const current = parseOwner(observed);
      if (current !== undefined && !ownerIsAlive(current.pid)) {
        if (await reclaimDeadOwner(path, observed)) continue;
      }
    } catch (cause) {
      if (codeOf(cause) === "ENOENT") continue;
      if (cause instanceof AccountStoreError) throw cause;
      throw new AccountStoreError(`Could not inspect accounts lock at ${path}`, { cause });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AccountStoreError(`Timed out waiting for accounts lock at ${path}`);
    }
    await waitForChange(path, remaining);
  }
}

async function release(path: string, owner: string): Promise<void> {
  try {
    if (await readFile(path, "utf-8") === owner) await rm(path);
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return;
    throw new AccountStoreError(`Could not release accounts lock at ${path}`, { cause });
  }
}

export async function withAccountLock<T>(accountsPath: string, operation: () => Promise<T>): Promise<T> {
  const path = `${accountsPath}.lock`;
  const owner = JSON.stringify({ pid: process.pid, uuid: randomUUID(), acquiredAt: Date.now() });
  await acquire(path, owner);
  try {
    return await operation();
  } finally {
    await release(path, owner);
  }
}
