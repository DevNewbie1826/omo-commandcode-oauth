/**
 * `AccountStore` owns the multi-account credential file: it loads and
 * validates the file at the boundary, persists every mutation atomically
 * (exclusively-created unique temp file + rename, mode 0600), and serializes
 * read-modify-write cycles through both an in-process mutex and a
 * cross-process lock file (`${path}.lock`) whose content names a unique
 * owner token. Release and the pre-write re-check are ownership-safe: a lock
 * stolen by a peer after its holder aged out is never unlinked or overwritten
 * by the original holder — the cycle restarts from the read instead.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountStoreError,
  parseAccountFile,
  serializeAccountFile,
  type AccountRecord,
  type AccountRecordInput,
} from "./schema.js";

/** Accounts file location: `COMMANDCODE_ACCOUNTS_FILE` else `~/.commandcode/omo-accounts.json`. */
export function resolveAccountsFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env["COMMANDCODE_ACCOUNTS_FILE"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".commandcode", "omo-accounts.json");
}

export interface AccountStoreOptions {
  readonly path: string;
  /** Injected clock used to default `createdAt` on newly added accounts. */
  readonly now?: () => number;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Delay between lock-acquisition retries (event-driven, never a busy loop). */
const LOCK_RETRY_DELAY_MS = 25;
/** Give up acquiring the cross-process lock after roughly this long. */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/** Locks older than this are presumed abandoned by a crashed writer. */
const LOCK_STALE_MS = 30_000;

/** The lock this instance currently holds: its path plus the content token proving ownership. */
interface LockOwnership {
  readonly lockPath: string;
  readonly token: string;
}

/**
 * Internal signal that the cross-process lock was lost mid-cycle (a peer
 * broke our aged-out lock). Never escapes the store: the write cycle
 * restarts from the read, bounded by the acquire deadline.
 */
class LockOwnershipLostError extends Error {
  constructor() {
    super("Accounts lock ownership was lost mid-cycle; restarting the write");
    this.name = "LockOwnershipLostError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class AccountStore {
  private records: readonly AccountRecord[] = [];
  private writeTail: Promise<unknown> = Promise.resolve();
  private lockHeld: LockOwnership | undefined;
  private readonly clock: () => number;

  constructor(private readonly options: AccountStoreOptions) {
    this.clock = options.now ?? (() => Date.now());
  }

  /** In-memory snapshot of the last loaded/persisted state. */
  accounts(): readonly AccountRecord[] {
    return this.records;
  }

  /**
   * (Re)read the file from disk and return the validated records. A missing
   * file yields an empty store; a malformed file throws `AccountStoreError`
   * and leaves previously loaded state untouched.
   */
  async load(): Promise<readonly AccountRecord[]> {
    return this.exclusive(async () => {
      this.records = await this.readFromDisk();
      return this.records;
    });
  }

  /** Append an account; rejects duplicate ids and duplicate credentials. */
  async add(input: AccountRecordInput): Promise<void> {
    await this.update((records) => {
      if (records.some((record) => record.id === input.id)) {
        throw new AccountStoreError(`Account id already exists: ${input.id}`);
      }
      if (records.some((record) => record.token === input.token)) {
        throw new AccountStoreError("Account credential already exists");
      }
      return [...records, this.normalize(input)];
    });
  }

  async remove(id: string): Promise<void> {
    await this.update((records) => {
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      return records.filter((record) => record.id !== id);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update((records) => {
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      return records.map((record) => (record.id === id ? { ...record, enabled } : record));
    });
  }

  /**
   * Read-modify-write escape hatch under the same write serialization as
   * add/remove/setEnabled. The transform must return the full next record
   * list; it is persisted atomically.
   */
  async mutate(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    await this.update(transform);
  }

  /**
   * Single read-modify-write cycle, serialized by BOTH the in-process write
   * chain (ordering within one store instance) and the cross-process lock
   * file (so two stores or two processes can never interleave read→write and
   * lose an update).
   */
  private async update(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    await this.exclusive(() => this.withFileLock(transform));
  }

  /**
   * Run one read-modify-write cycle under the cross-process lock. Lock
   * ownership is content-based: the lock file names its holder's unique
   * token, so a lock that aged out and was stolen by a peer is detectable.
   * Ownership is re-checked as the first act of the write itself (see
   * `persist`); if it was lost — a peer broke our aged lock, persisted, or
   * still holds it — the cycle aborts and restarts from the read, so the
   * peer's update can never be overwritten.
   */
  private async withFileLock(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    const lockPath = `${this.options.path}.lock`;
    const directory = dirname(this.options.path);
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw new AccountStoreError(`Could not prepare accounts directory at ${directory}`, {
        cause: error,
      });
    }
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      if (Date.now() >= deadline) {
        throw new AccountStoreError(`Timed out waiting for the accounts lock at ${lockPath}`);
      }
      const token = `${process.pid}-${randomUUID()}`;
      await this.acquireFileLock(lockPath, token, deadline);
      this.lockHeld = { lockPath, token };
      try {
        const records = await this.readFromDisk();
        const next = transform(records);
        await this.persist(next);
        this.records = next;
        return;
      } catch (error) {
        if (error instanceof LockOwnershipLostError) continue;
        throw error;
      } finally {
        this.lockHeld = undefined;
        await this.releaseFileLock(lockPath, token);
      }
    }
  }

  /**
   * Acquire the lock by exclusively creating `${path}.lock` (flag "wx", so
   * only one process ever holds it) with our ownership token as content.
   * Contention retries on a fixed event-driven backoff bounded by the cycle
   * deadline; a lock older than LOCK_STALE_MS is treated as abandoned by a
   * crashed or stalled writer and is replaced by ours (rm + exclusive
   * re-create: only the acquirer that wins the create owns the lock).
   */
  private async acquireFileLock(lockPath: string, token: string, deadline: number): Promise<void> {
    for (;;) {
      try {
        await writeFile(lockPath, token, { flag: "wx", mode: 0o600 });
        return;
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw new AccountStoreError(`Could not create accounts lock file at ${lockPath}`, {
            cause: error,
          });
        }
        if (await this.breakStaleLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          throw new AccountStoreError(`Timed out waiting for the accounts lock at ${lockPath}`);
        }
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * Whether the lock file's current content still names our token. An
   * unreadable or vanished lock proves nothing, so it counts as lost.
   */
  private async ownsLock(lockPath: string, token: string): Promise<boolean> {
    let contents: string;
    try {
      contents = await readFile(lockPath, "utf-8");
    } catch {
      // Unreadable or vanished: we cannot prove ownership, so the lock is
      // treated as lost and never released (release only removes our own).
      return false;
    }
    return contents === token;
  }

  /**
   * Remove the lock only if its content still names our token
   * (read-compare-unlink). A lock stolen by a peer after we aged out belongs
   * to the peer; unlinking it would destroy THEIR mutual exclusion. Release
   * is otherwise best-effort: a failed unlink leaves OUR lock behind, which
   * the stale-lock break recovers after LOCK_STALE_MS.
   */
  private async releaseFileLock(lockPath: string, token: string): Promise<void> {
    if (!(await this.ownsLock(lockPath, token))) return;
    try {
      await rm(lockPath, { force: true });
    } catch {
      // Best-effort: the leftover lock is ours and ages out of the way.
    }
  }

  /**
   * Replace the lock if its mtime is older than LOCK_STALE_MS: unlink it and
   * let the caller's exclusive re-create install our own token as the
   * content (only the acquirer that wins the create owns the lock). Returns
   * whether the caller should retry the exclusive create immediately.
   */
  private async breakStaleLock(lockPath: string): Promise<boolean> {
    let modifiedMs: number;
    try {
      modifiedMs = (await stat(lockPath)).mtimeMs;
    } catch {
      // The lock vanished between the failed create and this stat; retrying
      // the create lets it (or a peer) settle the race.
      return true;
    }
    if (Date.now() - modifiedMs <= LOCK_STALE_MS) return false;
    await rm(lockPath, { force: true });
    return true;
  }

  private normalize(input: AccountRecordInput): AccountRecord {
    const createdAt = input.createdAt ?? new Date(this.clock()).toISOString();
    return { ...input, enabled: input.enabled ?? true, createdAt };
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task);
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  private async readFromDisk(): Promise<readonly AccountRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.options.path, "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw new AccountStoreError(
        `Could not read accounts file at ${this.options.path}`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new AccountStoreError(
        `Accounts file at ${this.options.path} is not valid JSON`,
        { cause: error },
      );
    }

    return parseAccountFile(parsed).accounts;
  }

  private async persist(records: readonly AccountRecord[]): Promise<void> {
    // Ownership re-check: the FIRST act of the write. Anything that suspended
    // this writer between its locked read and here — a stall long enough for
    // a peer to break its aged lock, persist and release — is detected now,
    // before the file is touched. Losing ownership aborts the cycle (the
    // caller restarts from the read) instead of clobbering the peer's update.
    const held = this.lockHeld;
    if (held !== undefined && !(await this.ownsLock(held.lockPath, held.token))) {
      throw new LockOwnershipLostError();
    }
    // Unique temp name plus exclusive create: flag "wx" fails when the path
    // already exists, so a stale temp file left behind by a crashed run —
    // possibly carrying a weaker mode such as 0644 — can never be reused.
    // Mode 0o600 is therefore applied exactly once, at creation, and rename()
    // preserves it onto the credential file. No chmod is needed on any
    // platform we target because "wx" + mode is honored at create time; a
    // defensive chmod would only paper over a reused-temp regression.
    // Boundary check first: a refused serialization must surface its typed
    // field-naming error unwrapped, and must happen before any IO so the
    // previous valid file (or absence of one) is never touched.
    const contents = serializeAccountFile(records);
    const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      await writeFile(temporaryPath, contents, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.options.path);
    } catch (error) {
      throw new AccountStoreError(`Could not persist accounts file at ${this.options.path}`, {
        cause: error,
      });
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup of the temp file must not mask the original
        // write error; "force" already tolerates the file being gone after a
        // successful rename.
      }
    }
  }
}
