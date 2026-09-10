/*
 * `AccountStore` uses an append-only write-ahead journal plus identity-CAS
 * publication. Every operation and every derived-state publication receives
 * a monotonically increasing sequence number. The accounts file records the
 * highest sequence incorporated by its snapshot, allowing replay and journal
 * collection to distinguish stale publications from later operations.
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
  readonly now?: () => number;
  readonly onWarning?: (warning: AccountStoreJournalWarning) => void;
  /** Override only for deterministic stale-lock recovery tests. */
  readonly journalLockStaleMs?: number;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_WRITE_ATTEMPTS = 8;
const MAX_MUTATION_ATTEMPTS = 4;
const DEFAULT_JOURNAL_LOCK_STALE_MS = 15_000;
const MAX_JOURNAL_LOCK_ATTEMPTS = 10_000;
const JOURNAL_LOCK_RETRY_MS = 2;

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
      readonly baseLastAppliedSeq: number;
      readonly records: readonly AccountRecord[];
    };

type JournalEntry =
  | { readonly type: "op"; readonly id: string; readonly seq?: number; readonly operation: StoreOperation }
  | { readonly type: "commit"; readonly id: string }
  | { readonly type: "abort"; readonly id: string };

type JournalEntryDraft =
  | { readonly type: "op"; readonly id: string; readonly operation: StoreOperation }
  | { readonly type: "commit"; readonly id: string }
  | { readonly type: "abort"; readonly id: string };

interface JournalSnapshot {
  readonly contents: string;
  readonly entries: readonly JournalEntry[];
}

interface DiskSnapshot {
  readonly records: readonly AccountRecord[];
  readonly lastAppliedSeq: number;
  readonly exists: boolean;
}

let processCycleTail: Promise<unknown> = Promise.resolve();

function exclusiveAcrossInstances<T>(task: () => Promise<T>): Promise<T> {
  const run = processCycleTail.then(task, task);
  processCycleTail = run.catch(() => undefined);
  return run;
}

function parseNonNegativeSequence(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AccountStoreError(`Expected ${context} to be a non-negative safe integer`);
  }
  return value;
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
      baseLastAppliedSeq: parseNonNegativeSequence(
        value["baseLastAppliedSeq"],
        'journal field "baseLastAppliedSeq"',
      ),
      records,
    };
  }
  throw new AccountStoreError("Expected recognized journal operation kind");
}

function parseJournalEntry(value: unknown): JournalEntry {
  if (!isRecord(value)) throw new AccountStoreError("Expected journal line object");
  const type = value["type"];
  const id = requiredJournalString(value, "id");
  if (type === "commit" || type === "abort") return { type, id };
  if (type === "op") {
    return {
      type,
      id,
      seq: parseNonNegativeSequence(value["seq"], 'journal field "seq"'),
      operation: parseOperation(value["operation"]),
    };
  }
  throw new AccountStoreError("Expected recognized journal line type");
}

function sameRecord(left: AccountRecord, right: AccountRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecords(left: readonly AccountRecord[], right: readonly AccountRecord[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyNarrowOperation(
  records: readonly AccountRecord[],
  operation: Exclude<StoreOperation, { readonly kind: "state" }>,
): readonly AccountRecord[] {
  if (operation.kind === "remove") return records.filter((record) => record.id !== operation.id);
  if (operation.kind === "add") {
    if (records.some((record) => record.id === operation.record.id)) return records;
    if (records.some((record) => record.token === operation.record.token)) return records;
    return [...records, operation.record];
  }
  return records.map((record) => {
    if (record.id !== operation.id) return record;
    if (operation.kind === "enable") return { ...record, enabled: operation.enabled };
    return { ...record, retryAt: Math.max(record.retryAt ?? 0, operation.retryAtMs) };
  });
}

export class AccountStore {
  private records: readonly AccountRecord[] = [];
  private writeTail: Promise<unknown> = Promise.resolve();
  private readonly clock: () => number;
  private lastReadAppliedSeq = 0;
  private lastReadExists = false;

  constructor(private readonly options: AccountStoreOptions) {
    this.clock = options.now ?? (() => Date.now());
  }

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

  async add(input: AccountRecordInput): Promise<void> {
    const record = this.normalize(input);
    serializeAccountFile([record]);
    await this.update(
      (records) => {
        if (records.some((candidate) => candidate.id === record.id)) {
          throw new AccountStoreError(`Account id already exists: ${record.id}`);
        }
        if (records.some((candidate) => candidate.token === record.token)) {
          throw new AccountStoreError("Account credential already exists");
        }
        return { kind: "add", record };
      },
      (records) => {
        const matchingId = records.find((candidate) => candidate.id === record.id);
        if (matchingId === undefined) {
          if (records.some((candidate) => candidate.token === record.token)) {
            throw new AccountStoreError("Account credential already exists");
          }
          return false;
        }
        if (matchingId.token !== record.token) {
          throw new AccountStoreError(`Account id already exists: ${record.id}`);
        }
        if (!this.sameAddIntent(matchingId, record, input)) {
          throw new AccountStoreError("Account credential already exists");
        }
        return true;
      },
    );
  }

  async remove(id: string): Promise<void> {
    await this.update(
      (records) => {
        if (!records.some((record) => record.id === id)) {
          throw new AccountStoreError(`Unknown account id: ${id}`);
        }
        return { kind: "remove", id };
      },
      (records) => !records.some((record) => record.id === id),
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update(
      (records) => {
        const record = records.find((candidate) => candidate.id === id);
        if (record === undefined) throw new AccountStoreError(`Unknown account id: ${id}`);
        return record.enabled === enabled ? null : { kind: "enable", id, enabled };
      },
      (records) => records.find((record) => record.id === id)?.enabled === enabled,
    );
  }

  async mutate(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    await this.update(
      (records, baseLastAppliedSeq) => {
        const next = transform(records);
        serializeAccountFile(next);
        return this.narrowMutation(records, next, baseLastAppliedSeq);
      },
      (records) => {
        const intended = transform(records);
        serializeAccountFile(intended);
        return sameRecords(records, intended);
      },
    );
  }

  private async update(
    createOperation: (
      records: readonly AccountRecord[],
      baseLastAppliedSeq: number,
    ) => StoreOperation | null,
    effectPresent: (records: readonly AccountRecord[]) => boolean,
  ): Promise<void> {
    await this.exclusive(() =>
      exclusiveAcrossInstances(async () => {
        for (let attempt = 1; attempt <= MAX_MUTATION_ATTEMPTS; attempt += 1) {
          const records = await this.persistOperation(createOperation);
          if (effectPresent(records)) return;
        }
        throw new AccountStoreError("concurrent modification");
      }),
    );
  }

  private async persistOperation(
    createOperation: (
      records: readonly AccountRecord[],
      baseLastAppliedSeq: number,
    ) => StoreOperation | null,
  ): Promise<readonly AccountRecord[]> {
    let identity = await this.captureIdentity();
    let disk = await this.readDiskSnapshot();
    let journal = await this.readJournal();
    const baseSequence = this.maximumSequence(journal.entries, disk.lastAppliedSeq);
    const current = this.replay(disk.records, journal.entries, disk.lastAppliedSeq);
    const operation = createOperation(current, baseSequence);
    if (operation === null || sameRecords(current, applyOperationForComparison(current, operation))) {
      this.records = current;
      return current;
    }

    const operationId = randomUUID();
    await this.appendJournal({ type: "op", id: operationId, operation });

    try {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        identity = await this.captureIdentity();
        disk = await this.readDiskSnapshot();
        journal = await this.readJournal();
        const replayed = this.replay(disk.records, journal.entries, disk.lastAppliedSeq);
        const compactBase = this.maximumSequence(journal.entries, disk.lastAppliedSeq);
        const compactId = randomUUID();
        await this.appendJournal({
          type: "op",
          id: compactId,
          operation: { kind: "state", baseLastAppliedSeq: compactBase, records: replayed },
        });
        const withCompact = await this.readJournal();
        const compactSeq = this.operationSequence(withCompact.entries, compactId);
        const publishRecords = this.replay(
          disk.records,
          withCompact.entries,
          disk.lastAppliedSeq,
        );
        if (await this.persistCas(identity, serializeAccountFile(publishRecords, compactSeq))) {
          await this.appendJournal({ type: "commit", id: compactId });
          await this.appendJournal({ type: "commit", id: operationId });
          this.records = await this.reconcile();
          return this.records;
        }
        await this.appendJournal({ type: "abort", id: compactId });
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
    await this.collectJournal();
  }

  private narrowMutation(
    previous: readonly AccountRecord[],
    next: readonly AccountRecord[],
    baseLastAppliedSeq: number,
  ): StoreOperation | null {
    if (sameRecords(previous, next)) return null;
    const sameMembershipAndOrder =
      previous.length === next.length &&
      previous.every((record, index) => next[index]?.id === record.id);
    if (sameMembershipAndOrder) {
      const changed = previous.flatMap((record, index) => {
        const replacement = next[index];
        return replacement !== undefined && !sameRecord(record, replacement)
          ? [{ previous: record, next: replacement }]
          : [];
      });
      const [change] = changed;
      if (changed.length === 1 && change !== undefined) {
        if (sameRecord({ ...change.previous, enabled: change.next.enabled }, change.next)) {
          return { kind: "enable", id: change.next.id, enabled: change.next.enabled };
        }
        const retryAt = change.next.retryAt;
        if (
          retryAt !== undefined &&
          retryAt > (change.previous.retryAt ?? 0) &&
          sameRecord({ ...change.previous, retryAt }, change.next)
        ) {
          return { kind: "quarantine", id: change.next.id, retryAtMs: retryAt };
        }
      }
    }
    return { kind: "state", records: next, baseLastAppliedSeq };
  }

  private replay(
    records: readonly AccountRecord[],
    entries: readonly JournalEntry[],
    lastAppliedSeq = 0,
  ): readonly AccountRecord[] {
    const aborted = new Set(
      entries.filter((entry) => entry.type === "abort").map((entry) => entry.id),
    );
    let current = records;
    let highestApplied = lastAppliedSeq;
    for (const entry of entries) {
      if (entry.type !== "op" || aborted.has(entry.id)) continue;
      const seq = entry.seq;
      if (seq !== undefined && seq <= lastAppliedSeq) continue;
      if (entry.operation.kind === "state") {
        if (highestApplied <= entry.operation.baseLastAppliedSeq) current = entry.operation.records;
      } else {
        current = applyNarrowOperation(current, entry.operation);
      }
      if (seq !== undefined) highestApplied = Math.max(highestApplied, seq);
    }
    return current;
  }

  private async reconcile(): Promise<readonly AccountRecord[]> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const identity = await this.captureIdentity();
      const disk = await this.readDiskSnapshot();
      const journal = await this.readJournal();
      const replayed = this.replay(disk.records, journal.entries, disk.lastAppliedSeq);
      const maximumSeq = this.maximumSequence(journal.entries, disk.lastAppliedSeq);
      const needsPublication = maximumSeq > disk.lastAppliedSeq;
      if (!needsPublication) {
        if (journal.entries.length > 0) await this.collectJournal();
        return replayed;
      }

      const compactId = randomUUID();
      await this.appendJournal({
        type: "op",
        id: compactId,
        operation: {
          kind: "state",
          baseLastAppliedSeq: maximumSeq,
          records: replayed,
        },
      });
      const withCompact = await this.readJournal();
      const compactSeq = this.operationSequence(withCompact.entries, compactId);
      const publishRecords = this.replay(disk.records, withCompact.entries, disk.lastAppliedSeq);
      if (!(await this.persistCas(identity, serializeAccountFile(publishRecords, compactSeq)))) {
        await this.appendJournal({ type: "abort", id: compactId });
        continue;
      }
      await this.appendJournal({ type: "commit", id: compactId });
      await this.collectJournal();
      return publishRecords;
    }
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing while reconciling the journal`,
    );
  }

  private async collectJournal(): Promise<void> {
    await this.replaceJournalWithEmpty();
  }

  protected async replaceJournalWithEmpty(): Promise<void> {
    await this.withJournalLock(async () => {
      const disk = await this.readDiskSnapshotDirect();
      const journal = await this.readJournal();
      if (journal.entries.length === 0) return;
      const committed = new Set(
        journal.entries.flatMap((entry) => entry.type === "commit" ? [entry.id] : []),
      );
      const aborted = new Set(
        journal.entries.flatMap((entry) => entry.type === "abort" ? [entry.id] : []),
      );
      const collectableIds = new Set<string>();
      for (const entry of journal.entries) {
        if (entry.type !== "op" || entry.seq === undefined) continue;
        const publishedCommit =
          committed.has(entry.id) && entry.seq <= disk.lastAppliedSeq;
        if (!publishedCommit && !aborted.has(entry.id)) break;
        collectableIds.add(entry.id);
      }
      const retained = journal.entries.filter((entry) => !collectableIds.has(entry.id));
      if (collectableIds.size === 0) return;
      const accountTemporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
      const journalTemporaryPath = `${this.journalPath()}.${process.pid}.${randomUUID()}.tmp`;
      try {
        if (disk.exists) {
          await writeFile(
            accountTemporaryPath,
            serializeAccountFile(disk.records, disk.lastAppliedSeq),
            { encoding: "utf-8", flag: "wx", mode: 0o600 },
          );
          await rename(accountTemporaryPath, this.options.path);
        }
        if (retained.length === 0) {
          await rm(this.journalPath(), { force: true });
        } else {
          const contents = `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
          await writeFile(journalTemporaryPath, contents, {
            encoding: "utf-8",
            flag: "wx",
            mode: 0o600,
          });
          await rename(journalTemporaryPath, this.journalPath());
        }
      } catch (error) {
        await this.removeTemporary(accountTemporaryPath, error);
        await this.removeTemporary(journalTemporaryPath, error);
        throw new AccountStoreError(
          `Could not garbage-collect accounts journal at ${this.journalPath()}`,
          { cause: error },
        );
      }
      await this.removeTemporary(accountTemporaryPath);
      await this.removeTemporary(journalTemporaryPath);
    });
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
      if (hasErrorCode(error, "ENOENT")) return "";
      throw new AccountStoreError(`Could not read accounts journal at ${this.journalPath()}`, {
        cause: error,
      });
    }
  }

  protected async appendJournal(entry: JournalEntryDraft): Promise<void> {
    await this.withJournalLock(async () => {
      try {
        const contents = await this.readJournalContents();
        const disk = await this.readDiskSnapshotDirect();
        const parsed = await this.parseJournalContentsWithoutWarnings(contents);
        const seq = this.maximumSequence(parsed, disk.lastAppliedSeq) + 1;
        const framed = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
        const persisted = entry.type === "op" ? { ...entry, seq } : entry;
        const handle = await open(this.journalPath(), "a", 0o600);
        try {
          await handle.chmod(0o600);
          await handle.appendFile(`${framed}${JSON.stringify(persisted)}\n`, "utf-8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw new AccountStoreError(`Could not append accounts journal at ${this.journalPath()}`, {
          cause: error,
        });
      }
    });
  }

  private async parseJournalContentsWithoutWarnings(contents: string): Promise<readonly JournalEntry[]> {
    const entries: JournalEntry[] = [];
    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        entries.push(parseJournalEntry(parsed));
      } catch (error) {
        if (!(error instanceof Error)) {
          throw new AccountStoreError("Unexpected non-error while parsing accounts journal", {
            cause: error,
          });
        }
      }
    }
    return entries;
  }

  private maximumSequence(entries: readonly JournalEntry[], floor: number): number {
    return entries.reduce(
      (maximum, entry) =>
        entry.type === "op" && entry.seq !== undefined ? Math.max(maximum, entry.seq) : maximum,
      floor,
    );
  }

  private operationSequence(entries: readonly JournalEntry[], id: string): number {
    const operation = entries.find((entry) => entry.type === "op" && entry.id === id);
    if (operation === undefined || operation.type !== "op" || operation.seq === undefined) {
      throw new AccountStoreError(`Could not find appended journal operation ${id}`);
    }
    return operation.seq;
  }

  private journalPath(): string {
    return `${this.options.path}.journal`;
  }

  private journalLockPath(): string {
    return `${this.journalPath()}.lock`;
  }

  protected async withJournalLock<T>(task: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.options.path), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 1; attempt <= MAX_JOURNAL_LOCK_ATTEMPTS; attempt += 1) {
      try {
        handle = await open(this.journalLockPath(), "wx", 0o600);
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw new AccountStoreError(`Could not lock accounts journal at ${this.journalPath()}`, {
            cause: error,
          });
        }
        await this.stealJournalLockIfStale();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setTimeout(resolve, JOURNAL_LOCK_RETRY_MS));
      }
    }
    if (handle === undefined) {
      throw new AccountStoreError(`Timed out locking accounts journal at ${this.journalPath()}`);
    }
    const ownedLock = await handle.stat();
    try {
      return await task();
    } finally {
      let closeError: unknown;
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      }
      let cleanupError: unknown;
      try {
        const currentLock = await stat(this.journalLockPath());
        if (currentLock.ino === ownedLock.ino && currentLock.dev === ownedLock.dev) {
          await rm(this.journalLockPath());
        }
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) cleanupError = error;
      }
      if (closeError !== undefined || cleanupError !== undefined) {
        const cause = closeError === undefined
          ? cleanupError
          : cleanupError === undefined
            ? closeError
            : new AggregateError([closeError, cleanupError], "lock close and cleanup both failed");
        throw new AccountStoreError(`Could not release accounts journal lock at ${this.journalPath()}`, {
          cause,
        });
      }
    }
  }

  private async stealJournalLockIfStale(): Promise<void> {
    const staleMs = this.options.journalLockStaleMs ?? DEFAULT_JOURNAL_LOCK_STALE_MS;
    let lockStats: Awaited<ReturnType<typeof stat>>;
    try {
      lockStats = await stat(this.journalLockPath());
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw new AccountStoreError(`Could not inspect accounts journal lock at ${this.journalPath()}`, {
        cause: error,
      });
    }
    if (Date.now() - lockStats.mtimeMs < staleMs) return;
    const tombstone = `${this.journalLockPath()}.${process.pid}.${randomUUID()}.stale`;
    try {
      // An owner misclassified as dead can only overlap a line-framed atomic
      // append or another GC. Prefix GC is safe from lock ownership itself:
      // the account-file watermark is preserved, so an older compact cannot
      // become current again even if that owner resumes after the steal.
      await rename(this.journalLockPath(), tombstone);
      await rm(tombstone);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw new AccountStoreError(`Could not recover stale accounts journal lock at ${this.journalPath()}`, {
        cause: error,
      });
    }
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
      if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
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

  private sameAddIntent(
    candidate: AccountRecord,
    intended: AccountRecord,
    input: AccountRecordInput,
  ): boolean {
    const creditsMatch = input.credits === undefined || (
      candidate.credits?.monthly === intended.credits?.monthly &&
      candidate.credits?.purchased === intended.credits?.purchased &&
      candidate.credits?.free === intended.credits?.free &&
      candidate.credits?.periodEnd === intended.credits?.periodEnd
    );
    return (
      candidate.id === intended.id &&
      candidate.token === intended.token &&
      (input.userId === undefined || candidate.userId === intended.userId) &&
      (input.userName === undefined || candidate.userName === intended.userName) &&
      (input.keyName === undefined || candidate.keyName === intended.keyName) &&
      (input.enabled === undefined || candidate.enabled === intended.enabled) &&
      creditsMatch &&
      (input.retryAt === undefined || candidate.retryAt === intended.retryAt) &&
      (input.createdAt === undefined || candidate.createdAt === intended.createdAt)
    );
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task);
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  private async readDiskSnapshot(): Promise<DiskSnapshot> {
    const records = await this.readFromDisk();
    return {
      records,
      lastAppliedSeq: this.lastReadAppliedSeq,
      exists: this.lastReadExists,
    };
  }

  private async readDiskSnapshotDirect(): Promise<DiskSnapshot> {
    let contents: string;
    try {
      contents = await readFile(this.options.path, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { records: [], lastAppliedSeq: 0, exists: false };
      }
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
    const file = parseAccountFile(parsed);
    return {
      records: file.accounts,
      lastAppliedSeq: file.lastAppliedSeq ?? 0,
      exists: true,
    };
  }

  protected async readFromDisk(): Promise<readonly AccountRecord[]> {
    const snapshot = await this.readDiskSnapshotDirect();
    this.lastReadAppliedSeq = snapshot.lastAppliedSeq;
    this.lastReadExists = snapshot.exists;
    return snapshot.records;
  }
}

function applyOperationForComparison(
  records: readonly AccountRecord[],
  operation: StoreOperation,
): readonly AccountRecord[] {
  return operation.kind === "state" ? operation.records : applyNarrowOperation(records, operation);
}
