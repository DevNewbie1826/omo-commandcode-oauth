/*
 * `AccountStore` persists credentials with an identity-CAS fast path plus a
 * write-ahead journal. Every operation is appended to `${path}.journal`
 * before its account-file CAS and is marked committed only after that CAS.
 * Replaying the journal repairs a peer operation overwritten in the final
 * stat-to-rename window. Pending operations are never garbage-collected, so
 * a stale writer remains recoverable until it finishes. Both the credential
 * file and journal contain tokens and are created/rewritten with mode 0600.
 *
 * add/remove/enable/quarantine records are deterministic and idempotent;
 * operations for different account ids commute. The public arbitrary
 * `mutate()` escape hatch cannot in general be represented that way. Simple
 * enabled and monotonic retryAt changes are narrowed to deterministic ops;
 * every other transform is journaled as a full-state operation carrying its
 * base file identity and sequence id. State operations replay in journal
 * order (later snapshots win), which is honest last-writer ordering rather
 * than per-account commutativity for an unknowable arbitrary transform.
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACCOUNTS_FILE_VERSION,
  AccountStoreError,
  AccountStoreJournalWarning,
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
  /** Receives non-fatal typed warnings for malformed journal lines. */
  readonly onWarning?: (warning: AccountStoreJournalWarning) => void;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_WRITE_ATTEMPTS = 8;

type FileIdentity =
  | { readonly kind: "missing" }
  | {
      readonly kind: "present";
      readonly inode: number;
      readonly mtimeMs: number;
      readonly size: number;
    };

type StoreOperation =
  | { readonly kind: "add"; readonly record: AccountRecord }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "quarantine"; readonly id: string; readonly retryAtMs: number }
  | { readonly kind: "enable"; readonly id: string; readonly enabled: boolean }
  | {
      readonly kind: "state";
      readonly records: readonly AccountRecord[];
      readonly baseIdentity: FileIdentity;
      readonly seq: string;
    };

type JournalEntry =
  | { readonly type: "op"; readonly id: string; readonly operation: StoreOperation }
  | { readonly type: "commit"; readonly id: string }
  | { readonly type: "abort"; readonly id: string };

interface JournalSnapshot {
  readonly contents: string;
  readonly entries: readonly JournalEntry[];
}

let processCycleTail: Promise<unknown> = Promise.resolve();

function exclusiveAcrossInstances<T>(task: () => Promise<T>): Promise<T> {
  const run = processCycleTail.then(task, task);
  processCycleTail = run.catch(() => undefined);
  return run;
}

function parseIdentity(value: unknown): FileIdentity {
  if (!isRecord(value)) throw new AccountStoreError("Expected journal base identity object");
  if (value["kind"] === "missing") return { kind: "missing" };
  const inode = value["inode"];
  const mtimeMs = value["mtimeMs"];
  const size = value["size"];
  if (
    value["kind"] !== "present" ||
    typeof inode !== "number" ||
    !Number.isFinite(inode) ||
    typeof mtimeMs !== "number" ||
    !Number.isFinite(mtimeMs) ||
    typeof size !== "number" ||
    !Number.isFinite(size)
  ) {
    throw new AccountStoreError("Expected valid journal base identity");
  }
  return { kind: "present", inode, mtimeMs, size };
}

function parseSingleAccount(value: unknown): AccountRecord {
  const accounts = parseAccountFile({ version: ACCOUNTS_FILE_VERSION, accounts: [value] }).accounts;
  const [record] = accounts;
  if (record === undefined) throw new AccountStoreError("Expected journal account record");
  return record;
}

function requiredJournalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AccountStoreError(`Expected journal field "${key}" to be a non-empty string`);
  }
  return value;
}

function parseOperation(value: unknown): StoreOperation {
  if (!isRecord(value)) throw new AccountStoreError("Expected journal operation object");
  const kind = value["kind"];
  if (kind === "add") return { kind, record: parseSingleAccount(value["record"]) };
  if (kind === "remove") return { kind, id: requiredJournalString(value, "id") };
  if (kind === "enable") {
    const enabled = value["enabled"];
    if (typeof enabled !== "boolean") {
      throw new AccountStoreError('Expected journal field "enabled" to be a boolean');
    }
    return { kind, id: requiredJournalString(value, "id"), enabled };
  }
  if (kind === "quarantine") {
    const retryAtMs = value["retryAtMs"];
    if (typeof retryAtMs !== "number" || !Number.isInteger(retryAtMs) || retryAtMs < 0) {
      throw new AccountStoreError('Expected journal field "retryAtMs" to be a timestamp');
    }
    return { kind, id: requiredJournalString(value, "id"), retryAtMs };
  }
  if (kind === "state") {
    const records = parseAccountFile({
      version: ACCOUNTS_FILE_VERSION,
      accounts: value["records"],
    }).accounts;
    return {
      kind,
      records,
      baseIdentity: parseIdentity(value["baseIdentity"]),
      seq: requiredJournalString(value, "seq"),
    };
  }
  throw new AccountStoreError("Expected recognized journal operation kind");
}

function parseJournalEntry(value: unknown): JournalEntry {
  if (!isRecord(value)) throw new AccountStoreError("Expected journal line object");
  const type = value["type"];
  const id = requiredJournalString(value, "id");
  if (type === "commit" || type === "abort") return { type, id };
  if (type === "op") return { type, id, operation: parseOperation(value["operation"]) };
  throw new AccountStoreError("Expected recognized journal line type");
}

function sameRecord(left: AccountRecord, right: AccountRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyOperation(
  records: readonly AccountRecord[],
  operation: StoreOperation,
): readonly AccountRecord[] {
  if (operation.kind === "state") return operation.records;
  if (operation.kind === "remove") return records.filter((record) => record.id !== operation.id);
  if (operation.kind === "add") {
    const existing = records.find((record) => record.id === operation.record.id);
    if (existing !== undefined) return records;
    if (records.some((record) => record.token === operation.record.token)) return records;
    return [...records, operation.record];
  }
  return records.map((record) => {
    if (record.id !== operation.id) return record;
    if (operation.kind === "enable") return { ...record, enabled: operation.enabled };
    const retryAt = Math.max(record.retryAt ?? 0, operation.retryAtMs);
    return { ...record, retryAt };
  });
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

  async load(): Promise<readonly AccountRecord[]> {
    return this.exclusive(() =>
      exclusiveAcrossInstances(async () => {
        this.records = await this.reconcile();
        return this.records;
      }),
    );
  }

  /** Append an account; rejects duplicate ids and duplicate credentials. */
  async add(input: AccountRecordInput): Promise<void> {
    const record = this.normalize(input);
    serializeAccountFile([record]);
    await this.update((records) => {
      if (records.some((candidate) => candidate.id === record.id)) {
        throw new AccountStoreError(`Account id already exists: ${record.id}`);
      }
      if (records.some((candidate) => candidate.token === record.token)) {
        throw new AccountStoreError("Account credential already exists");
      }
      return { kind: "add", record };
    });
  }

  async remove(id: string): Promise<void> {
    await this.update((records) => {
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      return { kind: "remove", id };
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update((records) => {
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      return { kind: "enable", id, enabled };
    });
  }

  async mutate(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    await this.update((records, identity) => {
      const next = transform(records);
      serializeAccountFile(next);
      return this.narrowMutation(records, next, identity);
    });
  }

  private async update(
    createOperation: (records: readonly AccountRecord[], identity: FileIdentity) => StoreOperation,
  ): Promise<void> {
    await this.exclusive(() =>
      exclusiveAcrossInstances(() => this.persistOperation(createOperation)),
    );
  }

  private async persistOperation(
    createOperation: (records: readonly AccountRecord[], identity: FileIdentity) => StoreOperation,
  ): Promise<void> {
    let identity = await this.captureIdentity();
    let diskRecords = await this.readFromDisk();
    let journal = await this.readJournal();
    const current = this.replay(diskRecords, journal.entries);
    const operation = createOperation(current, identity);
    const operationId = randomUUID();
    await this.appendJournal({ type: "op", id: operationId, operation });

    try {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        if (attempt > 1) {
          identity = await this.captureIdentity();
          diskRecords = await this.readFromDisk();
          journal = await this.readJournal();
        } else {
          journal = await this.readJournal();
        }
        const next = this.replay(diskRecords, journal.entries);
        const contents = serializeAccountFile(next);
        if (await this.persistCas(identity, contents)) {
          await this.appendJournal({ type: "commit", id: operationId });
          this.records = await this.reconcile();
          return;
        }
      }
    } catch (error) {
      await this.abortOperation(operationId);
      throw error;
    }

    await this.abortOperation(operationId);
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing under concurrent writers; gave up after ${MAX_WRITE_ATTEMPTS} attempts`,
    );
  }

  private async abortOperation(operationId: string): Promise<void> {
    await this.appendJournal({ type: "abort", id: operationId });
    await this.reconcile();
  }

  private narrowMutation(
    previous: readonly AccountRecord[],
    next: readonly AccountRecord[],
    baseIdentity: FileIdentity,
  ): StoreOperation {
    if (previous.length === next.length) {
      const changed = previous.flatMap((record) => {
        const replacement = next.find((candidate) => candidate.id === record.id);
        return replacement !== undefined && !sameRecord(record, replacement)
          ? [{ previous: record, next: replacement }]
          : [];
      });
      const [change] = changed;
      if (changed.length === 1 && change !== undefined) {
        const enabledOnly = sameRecord(
          { ...change.previous, enabled: change.next.enabled },
          change.next,
        );
        if (enabledOnly) {
          return { kind: "enable", id: change.next.id, enabled: change.next.enabled };
        }
        const nextRetryAt = change.next.retryAt;
        const quarantineOnly =
          nextRetryAt !== undefined &&
          sameRecord({ ...change.previous, retryAt: nextRetryAt }, change.next) &&
          nextRetryAt >= (change.previous.retryAt ?? 0);
        if (quarantineOnly) {
          return { kind: "quarantine", id: change.next.id, retryAtMs: nextRetryAt };
        }
      }
    }
    return { kind: "state", records: next, baseIdentity, seq: randomUUID() };
  }

  private replay(
    records: readonly AccountRecord[],
    entries: readonly JournalEntry[],
  ): readonly AccountRecord[] {
    const aborted = new Set(
      entries.filter((entry) => entry.type === "abort").map((entry) => entry.id),
    );
    return entries.reduce(
      (current, entry) =>
        entry.type === "op" && !aborted.has(entry.id)
          ? applyOperation(current, entry.operation)
          : current,
      records,
    );
  }

  private async reconcile(): Promise<readonly AccountRecord[]> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const identity = await this.captureIdentity();
      const diskRecords = await this.readFromDisk();
      const journal = await this.readJournal();
      const replayed = this.replay(diskRecords, journal.entries);
      if (serializeAccountFile(replayed) !== serializeAccountFile(diskRecords)) {
        if (!(await this.persistCas(identity, serializeAccountFile(replayed)))) continue;
      }
      await this.collectJournal(journal);
      return replayed;
    }
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing while reconciling the journal`,
    );
  }

  private async collectJournal(snapshot: JournalSnapshot): Promise<void> {
    const operationIds = snapshot.entries
      .filter((entry) => entry.type === "op")
      .map((entry) => entry.id);
    const settled = new Set(
      snapshot.entries
        .filter((entry) => entry.type === "commit" || entry.type === "abort")
        .map((entry) => entry.id),
    );
    if (operationIds.some((id) => !settled.has(id))) return;

    const currentContents = await this.readJournalContents();
    if (currentContents !== snapshot.contents) return;
    await this.replaceJournalWithEmpty();
  }

  private async readJournal(): Promise<JournalSnapshot> {
    const contents = await this.readJournalContents();
    const entries: JournalEntry[] = [];
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        entries.push(parseJournalEntry(parsed));
      } catch (error) {
        this.warn(
          new AccountStoreJournalWarning(
            `Ignored malformed accounts journal line ${index + 1} at ${this.journalPath()}`,
            { cause: error },
          ),
        );
      }
    }
    return { contents, entries };
  }

  private async readJournalContents(): Promise<string> {
    try {
      return await readFile(this.journalPath(), "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) return "";
      throw new AccountStoreError(`Could not read accounts journal at ${this.journalPath()}`, {
        cause: error,
      });
    }
  }

  private async appendJournal(entry: JournalEntry): Promise<void> {
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      const handle = await open(this.journalPath(), "a", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf-8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new AccountStoreError(`Could not append accounts journal at ${this.journalPath()}`, {
        cause: error,
      });
    }
  }

  private async replaceJournalWithEmpty(): Promise<void> {
    const temporaryPath = `${this.journalPath()}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, "", { encoding: "utf-8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.journalPath());
      await rm(this.journalPath(), { force: true });
    } catch (error) {
      await this.removeTemporary(temporaryPath, error);
      throw new AccountStoreError(`Could not garbage-collect accounts journal at ${this.journalPath()}`, {
        cause: error,
      });
    }
    await this.removeTemporary(temporaryPath);
  }

  private journalPath(): string {
    return `${this.options.path}.journal`;
  }

  private warn(warning: AccountStoreJournalWarning): void {
    if (this.options.onWarning !== undefined) this.options.onWarning(warning);
    else console.warn(warning.message);
  }

  protected async captureIdentity(): Promise<FileIdentity> {
    try {
      const stats = await stat(this.options.path);
      return { kind: "present", inode: stats.ino, mtimeMs: stats.mtimeMs, size: stats.size };
    } catch (error) {
      if (isMissingFileError(error)) return { kind: "missing" };
      throw new AccountStoreError(`Could not inspect accounts file at ${this.options.path}`, {
        cause: error,
      });
    }
  }

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

  protected async persistCas(expected: FileIdentity, contents: string): Promise<boolean> {
    const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      await writeFile(temporaryPath, contents, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      if (!this.sameIdentity(expected, await this.captureIdentity())) {
        await this.removeTemporary(temporaryPath);
        return false;
      }
      await rename(temporaryPath, this.options.path);
    } catch (error) {
      await this.removeTemporary(temporaryPath, error);
      throw new AccountStoreError(`Could not persist accounts file at ${this.options.path}`, {
        cause: error,
      });
    }
    await this.removeTemporary(temporaryPath);
    return true;
  }

  private async removeTemporary(path: string, primaryError?: unknown): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch (cleanupError) {
      const cause =
        primaryError === undefined
          ? cleanupError
          : new AggregateError([primaryError, cleanupError], "write and cleanup both failed");
      throw new AccountStoreError(`Could not remove temporary file at ${path}`, { cause });
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

  protected async readFromDisk(): Promise<readonly AccountRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.options.path, "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw new AccountStoreError(`Could not read accounts file at ${this.options.path}`, {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new AccountStoreError(`Accounts file at ${this.options.path} is not valid JSON`, {
        cause: error,
      });
    }
    return parseAccountFile(parsed).accounts;
  }
}
