/**
 * `AccountStore` owns the multi-account credential file: it loads and
 * validates the file at the boundary, and persists every mutation through an
 * optimistic-concurrency cycle instead of a lock file. Each cycle captures
 * the file's on-disk identity (inode, mtime, size — "missing" for an absent
 * file), reads and transforms the records, writes the next content to an
 * exclusively-created 0600 temp file, and renames it over the target only if
 * a fresh stat still reports the captured identity. Any mismatch — a peer
 * persisted in between, or the file appeared or vanished — discards the temp
 * file and restarts the whole cycle from a fresh capture and read, bounded by
 * attempts before a typed `AccountStoreError` gives up. Mutation cycles are
 * additionally serialized first within one store instance by an in-process
 * write chain, then across every store instance in the process by a
 * module-level cycle chain — so a same-process peer's cycle is never even
 * submitted (its first stat included) between this cycle's identity verify
 * and its atomic rename.
 *
 * Guarantee level: rename(2) is atomic, so identity-verify + rename is the
 * standard CAS-on-rename protocol. Within one process the cycle chains make
 * it exact: no same-process writer can interleave. Across processes, every
 * write this store performs lands a fresh inode (the temp file's), so any
 * interleaved persist by another process is detected at the verify step. The
 * residual window in which another PROCESS replaces the file between our
 * verify stat and our rename is inherent to compare-then-rename: there is no
 * portable atomic file-compare-and-swap syscall to close it. With inode +
 * nanosecond-mtime identity this is the practical guarantee level of the
 * protocol on APFS/ext4, and it strictly dominates the old stealable lock
 * file, whose check-then-write and check-then-unlink windows were reachable
 * by ordinary aging schedules.
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

/**
 * Maximum optimistic-concurrency attempts (capture identity → read → verify →
 * rename) per mutation before giving up with a typed error.
 */
const MAX_WRITE_ATTEMPTS = 8;

/**
 * The captured on-disk identity of the accounts file: the expected value for
 * a mutation's compare-and-rename. An absent file has the distinct "missing"
 * identity, so the file appearing or disappearing mid-cycle is a conflict
 * too, never a silent overwrite.
 */
type FileIdentity =
  | { readonly kind: "missing" }
  | {
      readonly kind: "present";
      readonly inode: number;
      readonly mtimeMs: number;
      readonly size: number;
    };

/**
 * Process-wide serialization of mutation cycles. Distinct `AccountStore`
 * instances in one process must not run their capture→verify→rename cycles
 * interleaved: two lockstep cycles could both verify the same pre-rename
 * identity and both rename, clobbering the first writer. Chaining every
 * cycle in the process behind one promise tail means a peer's cycle is not
 * even submitted (its first stat included) until this cycle's rename has
 * fully landed, closing the compare-then-rename window for same-process
 * writers entirely. Cross-process writers still rely on the identity CAS.
 */
let processCycleTail: Promise<unknown> = Promise.resolve();

function exclusiveAcrossInstances<T>(task: () => Promise<T>): Promise<T> {
  const run = processCycleTail.then(task, task);
  processCycleTail = run.catch(() => undefined);
  return run;
}

export class AccountStore {
  private records: readonly AccountRecord[] = [];
  private writeTail: Promise<unknown> = Promise.resolve();
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
   * Single read-modify-write cycle, serialized by the in-process write chain
   * (ordering within one store instance) and by the identity compare-and-
   * rename (so two stores in different processes can never interleave
   * read→write and lose an update).
   */
  private async update(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    await this.exclusive(() => {
      return exclusiveAcrossInstances(() => this.persistTransformed(transform));
    });
  }

  /**
   * One optimistic-concurrency mutation. Capture the file's identity, read
   * and transform the records, then attempt the compare-and-rename. An
   * identity mismatch — a peer wrote between our read and our verify, or the
   * file appeared or vanished — restarts the whole cycle from a fresh capture
   * and read, so the peer's update can never be overwritten; after
   * MAX_WRITE_ATTEMPTS conflicting attempts the mutation fails with a typed
   * error instead of guessing. The transform and serialization run before any
   * filesystem mutation, so a refused boundary error never touches disk.
   * Callers serialize: per instance through the write chain, and across all
   * instances in this process through the module-level cycle chain.
   */
  private async persistTransformed(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const identity = await this.captureIdentity();
      const records = await this.readFromDisk();
      const next = transform(records);
      const contents = serializeAccountFile(next);
      if (await this.persistCas(identity, contents)) {
        this.records = next;
        return;
      }
    }
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing under concurrent writers; gave up after ${MAX_WRITE_ATTEMPTS} attempts`,
    );
  }

  /**
   * Observe the accounts file's current identity for the compare-and-rename.
   * Only ENOENT maps to the "missing" identity; any other stat failure is
   * typed.
   */
  private async captureIdentity(): Promise<FileIdentity> {
    try {
      const stats = await stat(this.options.path);
      return { kind: "present", inode: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      if (isMissingFileError(error)) return { kind: "missing" };
      throw new AccountStoreError(
        `Could not inspect accounts file at ${this.options.path}`,
        { cause: error },
      );
    }
  }

  /** Whether the file still exhibits exactly the captured identity. */
  private sameIdentity(expected: FileIdentity, current: FileIdentity): boolean {
    if (expected.kind === "missing" || current.kind === "missing") {
      return expected.kind === "missing" && current.kind === "missing";
    }
    return (
      expected.inode === current.inode &&
      expected.mtimeMs === current.mtimeMs &&
      expected.size === current.size
    );
  }

  /**
   * Compare-and-rename: write `contents` to an exclusively-created 0600 temp
   * file, verify the accounts file still exhibits `expected`'s identity, and
   * only then rename the temp file over it — atomic, so readers never observe
   * a partial file. On identity mismatch the temp file is discarded (in the
   * finally below) and the caller retries the whole read cycle. Returns
   * whether the mutation landed.
   */
  private async persistCas(expected: FileIdentity, contents: string): Promise<boolean> {
    // Unique temp name plus exclusive create: flag "wx" fails when the path
    // already exists, so a stale temp file left behind by a crashed run —
    // possibly carrying a weaker mode such as 0644 — can never be reused.
    // Mode 0o600 is therefore applied exactly once, at creation, and rename()
    // preserves it onto the credential file. No chmod is needed on any
    // platform we target because "wx" + mode is honored at create time; a
    // defensive chmod would only paper over a reused-temp regression.
    const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      await writeFile(temporaryPath, contents, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      if (!this.sameIdentity(expected, await this.captureIdentity())) {
        // A peer replaced, created, or removed the file since our read:
        // discard this attempt and restart from a fresh read.
        return false;
      }
      await rename(temporaryPath, this.options.path);
      return true;
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
}
