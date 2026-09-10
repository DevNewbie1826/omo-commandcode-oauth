/* SIZE_OK: journal recovery, publication, and OCC stay colocated so subclasses
 * can exercise the real persistence seams without a parallel test model.
 *
 * `AccountStore` uses an append-only write-ahead journal plus immutable,
 * sequence-named state publications. The highest accounts.v<seq>.json file is
 * authoritative, so a delayed writer can publish only an older version, never
 * replace newer state. The canonical accounts path is a best-effort mirror for
 * humans and legacy tooling; correctness never depends on it once a version
 * file exists.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  ACCOUNTS_FILE_VERSION,
  AccountStoreError,
  AccountStoreJournalWarning,
  parseAccountFile,
  parseAccountOperationDisposition,
  serializeAccountFile,
  type AccountOperationDisposition,
  type AccountOperationOutcome,
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
const MAX_VERSION_SELECTION_ATTEMPTS = 8;
const DEFAULT_JOURNAL_LOCK_STALE_MS = 15_000;
const MAX_JOURNAL_LOCK_ATTEMPTS = 10_000;
const JOURNAL_LOCK_RETRY_MS = 2;
const VERSION_RETENTION_DISTANCE = 5;

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
  | {
      readonly type: "op";
      readonly id: string;
      readonly opId: string;
      readonly seq?: number;
      readonly operation: StoreOperation;
    }
  | { readonly type: "commit"; readonly id: string }
  | { readonly type: "abort"; readonly id: string };

type JournalEntryDraft =
  | { readonly type: "op"; readonly id: string; readonly opId: string; readonly operation: StoreOperation }
  | { readonly type: "commit"; readonly id: string }
  | { readonly type: "abort"; readonly id: string };

interface JournalSnapshot {
  readonly liveContents: string;
  readonly entries: readonly JournalEntry[];
}

interface DiskSnapshot {
  readonly records: readonly AccountRecord[];
  readonly lastAppliedSeq: number;
  readonly exists: boolean;
}

interface VersionSnapshot extends DiskSnapshot {
  readonly name: string;
  readonly path: string;
  readonly publicationSeq: number;
}

type MutationDisposition = AccountOperationOutcome | "complete" | "never-applied";

interface PersistResult {
  readonly records: readonly AccountRecord[];
  readonly disposition: MutationDisposition;
}

interface ReplayResult {
  readonly records: readonly AccountRecord[];
  readonly dispositions: readonly Omit<AccountOperationDisposition, "version">[];
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
    const opIdValue = value["opId"];
    return {
      type,
      id,
      // Pre-disposition journals used the transaction id as operation identity.
      opId: opIdValue === undefined ? id : requiredJournalString(value, "opId"),
      seq: parseNonNegativeSequence(value["seq"], 'journal field "seq"'),
      operation: parseOperation(value["operation"]),
    };
  }
  throw new AccountStoreError("Expected recognized journal line type");
}

type AccountRecordField = Exclude<keyof AccountRecord, "id" | "credits">;
type AccountRecordLeaf =
  | AccountRecordField
  | "credits.monthly"
  | "credits.purchased"
  | "credits.free"
  | "credits.periodEnd";

const ACCOUNT_RECORD_LEAVES: readonly AccountRecordLeaf[] = [
  "token",
  "userId",
  "userName",
  "keyName",
  "enabled",
  "retryAt",
  "createdAt",
  "credits.monthly",
  "credits.purchased",
  "credits.free",
  "credits.periodEnd",
];

interface ChangedRecordEffect {
  readonly id: string;
  readonly intended: AccountRecord;
  readonly leaves: readonly AccountRecordLeaf[];
}

interface StateEffect {
  readonly added: readonly AccountRecord[];
  readonly removedIds: readonly string[];
  readonly changed: readonly ChangedRecordEffect[];
}

function sameCredits(
  left: AccountRecord["credits"],
  right: AccountRecord["credits"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.monthly === right.monthly &&
    left.purchased === right.purchased &&
    left.free === right.free &&
    left.periodEnd === right.periodEnd
  );
}

function recordLeaf(record: AccountRecord, leaf: AccountRecordLeaf): unknown {
  if (leaf === "credits.monthly") return record.credits?.monthly;
  if (leaf === "credits.purchased") return record.credits?.purchased;
  if (leaf === "credits.free") return record.credits?.free;
  if (leaf === "credits.periodEnd") return record.credits?.periodEnd;
  return record[leaf];
}

function sameRecordLeaf(
  left: AccountRecord,
  right: AccountRecord,
  leaf: AccountRecordLeaf,
): boolean {
  return recordLeaf(left, leaf) === recordLeaf(right, leaf);
}

function sameRecord(left: AccountRecord, right: AccountRecord): boolean {
  return (
    left.id === right.id &&
    ACCOUNT_RECORD_LEAVES.every((leaf) => sameRecordLeaf(left, right, leaf))
  );
}

function sameRecords(left: readonly AccountRecord[], right: readonly AccountRecord[]): boolean {
  return (
    left.length === right.length &&
    left.every((record, index) => {
      const candidate = right[index];
      return candidate !== undefined && sameRecord(record, candidate);
    })
  );
}

function describeStateEffect(
  base: readonly AccountRecord[],
  intended: readonly AccountRecord[],
): StateEffect {
  const baseById = new Map(base.map((record) => [record.id, record]));
  const intendedById = new Map(intended.map((record) => [record.id, record]));
  const added: AccountRecord[] = [];
  const changed: ChangedRecordEffect[] = [];

  for (const record of intended) {
    const baseRecord = baseById.get(record.id);
    if (baseRecord === undefined) {
      added.push(record);
      continue;
    }
    const leaves = ACCOUNT_RECORD_LEAVES.filter(
      (leaf) => !sameRecordLeaf(baseRecord, record, leaf),
    );
    if (leaves.length > 0) changed.push({ id: record.id, intended: record, leaves });
  }

  return {
    added,
    removedIds: base.filter((record) => !intendedById.has(record.id)).map((record) => record.id),
    changed,
  };
}

function stateEffectPresent(records: readonly AccountRecord[], effect: StateEffect): boolean {
  const currentById = new Map(records.map((record) => [record.id, record]));
  if (effect.removedIds.some((id) => currentById.has(id))) return false;
  if (effect.added.some((record) => !currentById.has(record.id))) return false;
  return effect.changed.every((change) => {
    const current = currentById.get(change.id);
    return current !== undefined && change.leaves.every(
      (leaf) => sameRecordLeaf(current, change.intended, leaf),
    );
  });
}

function anyStateEffectPresent(records: readonly AccountRecord[], effect: StateEffect): boolean {
  const currentById = new Map(records.map((record) => [record.id, record]));
  if (effect.removedIds.some((id) => !currentById.has(id))) return true;
  if (effect.added.some((record) => currentById.has(record.id))) return true;
  return effect.changed.some((change) => {
    const current = currentById.get(change.id);
    return current !== undefined && change.leaves.some(
      (leaf) => sameRecordLeaf(current, change.intended, leaf),
    );
  });
}

function repairChangedRecord(
  current: AccountRecord,
  change: ChangedRecordEffect,
): AccountRecord {
  const leaves = new Set(change.leaves);
  const intended = change.intended;
  const creditChanged = change.leaves.some((leaf) => leaf.startsWith("credits."));
  let credits = current.credits;
  if (creditChanged) {
    if (intended.credits === undefined || current.credits === undefined) {
      credits = intended.credits;
    } else {
      credits = {
        monthly: leaves.has("credits.monthly") ? intended.credits.monthly : current.credits.monthly,
        purchased: leaves.has("credits.purchased")
          ? intended.credits.purchased
          : current.credits.purchased,
        free: leaves.has("credits.free") ? intended.credits.free : current.credits.free,
        periodEnd: leaves.has("credits.periodEnd")
          ? intended.credits.periodEnd
          : current.credits.periodEnd,
      };
    }
  }
  return {
    ...current,
    token: leaves.has("token") ? intended.token : current.token,
    userId: leaves.has("userId") ? intended.userId : current.userId,
    userName: leaves.has("userName") ? intended.userName : current.userName,
    keyName: leaves.has("keyName") ? intended.keyName : current.keyName,
    enabled: leaves.has("enabled") ? intended.enabled : current.enabled,
    retryAt: leaves.has("retryAt") ? intended.retryAt : current.retryAt,
    createdAt: leaves.has("createdAt") ? intended.createdAt : current.createdAt,
    credits,
  };
}

function repairStateEffect(
  records: readonly AccountRecord[],
  effect: StateEffect,
): readonly AccountRecord[] {
  const removed = new Set(effect.removedIds);
  const changes = new Map(effect.changed.map((change) => [change.id, change]));
  const repaired = records
    .filter((record) => !removed.has(record.id))
    .map((record) => {
      const change = changes.get(record.id);
      return change === undefined ? record : repairChangedRecord(record, change);
    });
  const currentIds = new Set(repaired.map((record) => record.id));
  const additions = effect.added.filter((record) => !currentIds.has(record.id));
  return [...repaired, ...additions];
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
  private readonly warnedJournalLines = new Set<string>();
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
    let effect: StateEffect = { added: [], removedIds: [], changed: [] };
    await this.update(
      (records, baseLastAppliedSeq) => {
        const intended = transform(records);
        serializeAccountFile(intended);
        effect = describeStateEffect(records, intended);
        return sameRecords(records, intended)
          ? null
          : { kind: "state", records: intended, baseLastAppliedSeq };
      },
      (records) => stateEffectPresent(records, effect),
      (records, baseLastAppliedSeq) => {
        const repaired = repairStateEffect(records, effect);
        return sameRecords(records, repaired)
          ? null
          : { kind: "state", records: repaired, baseLastAppliedSeq };
      },
      (records) => anyStateEffectPresent(records, effect),
    );
  }

  private async update(
    createOperation: (
      records: readonly AccountRecord[],
      baseLastAppliedSeq: number,
    ) => StoreOperation | null,
    effectPresent: (records: readonly AccountRecord[]) => boolean,
    repairAppliedEffect?: (
      records: readonly AccountRecord[],
      baseLastAppliedSeq: number,
    ) => StoreOperation | null,
    anyEffectPresent: (records: readonly AccountRecord[]) => boolean = effectPresent,
  ): Promise<void> {
    await this.exclusive(() =>
      exclusiveAcrossInstances(async () => {
        let operationFactory = createOperation;
        for (let attempt = 1; attempt <= MAX_MUTATION_ATTEMPTS; attempt += 1) {
          const result = await this.persistOperation(operationFactory);
          if (result.disposition === "complete") return;
          if (result.disposition === "applied") {
            if (effectPresent(result.records)) return;
            // If every changed leaf was subsequently erased, preserve the
            // accepted OCC retry contract without invoking a non-idempotent
            // transform twice. A partially retained effect is application
            // evidence and later overlapping writes remain last-writer-wins.
            if (repairAppliedEffect !== undefined && !anyEffectPresent(result.records)) {
              operationFactory = repairAppliedEffect;
              continue;
            }
            return;
          }
          if (result.disposition === "rejected-duplicate") {
            if (effectPresent(result.records)) return;
            throw new AccountStoreError("Account credential already exists");
          }
          if (result.disposition === "skipped-stale" && effectPresent(result.records)) return;
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
  ): Promise<PersistResult> {
    let identity = await this.captureIdentity();
    let disk = await this.readDiskSnapshot();
    let journal = await this.readJournal();
    const baseSequence = this.maximumSequence(journal.entries, disk.lastAppliedSeq);
    const current = this.replay(disk.records, journal.entries, disk.lastAppliedSeq);
    const operation = createOperation(current, baseSequence);
    if (operation === null || sameRecords(current, applyOperationForComparison(current, operation))) {
      this.records = current;
      return { records: current, disposition: "complete" };
    }

    const operationId = randomUUID();
    await this.appendJournal({ type: "op", id: operationId, opId: operationId, operation });

    try {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        const settled = await this.operationDisposition(operationId);
        if (settled !== undefined) {
          this.records = await this.reconcile();
          return { records: this.records, disposition: settled.outcome };
        }

        identity = await this.captureIdentity();
        disk = await this.readDiskSnapshot();
        journal = await this.readJournal();
        const replayed = this.replay(disk.records, journal.entries, disk.lastAppliedSeq);
        const compactBase = this.maximumSequence(journal.entries, disk.lastAppliedSeq);
        const compactId = randomUUID();
        await this.appendJournal({
          type: "op",
          id: compactId,
          opId: compactId,
          operation: { kind: "state", baseLastAppliedSeq: compactBase, records: replayed },
        });
        disk = await this.readDiskSnapshot();
        const withCompact = await this.readJournal();
        const compact = withCompact.entries.find(
          (entry) => entry.type === "op" && entry.id === compactId,
        );
        if (compact === undefined || compact.type !== "op" || compact.seq === undefined) continue;
        const compactSeq = compact.seq;
        if (disk.lastAppliedSeq >= compactSeq) continue;
        const publication = this.replayWithDispositions(
          disk.records,
          withCompact.entries,
          disk.lastAppliedSeq,
        );
        if (await this.persistCas(
          identity,
          serializeAccountFile(publication.records, compactSeq),
          publication.dispositions,
        )) {
          await this.appendJournal({ type: "commit", id: compactId });
          await this.appendJournal({ type: "commit", id: operationId });
          this.records = await this.reconcile();
          const disposition = await this.operationDisposition(operationId);
          return {
            records: this.records,
            disposition: disposition?.outcome ?? "never-applied",
          };
        }
        await this.appendJournal({ type: "abort", id: compactId });
        const disposition = await this.operationDisposition(operationId);
        if (disposition !== undefined) {
          this.records = await this.reconcile();
          return { records: this.records, disposition: disposition.outcome };
        }
        const remaining = await this.readJournal();
        if (!remaining.entries.some(
          (entry) => entry.type === "op" && entry.opId === operationId,
        )) {
          this.records = await this.reconcile();
          return { records: this.records, disposition: "never-applied" };
        }
      }
    } catch (error) {
      await this.abortOperation(operationId);
      throw error;
    }

    const disposition = await this.operationDisposition(operationId);
    if (disposition !== undefined) {
      this.records = await this.reconcile();
      return { records: this.records, disposition: disposition.outcome };
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

  private replay(
    records: readonly AccountRecord[],
    entries: readonly JournalEntry[],
    lastAppliedSeq = 0,
  ): readonly AccountRecord[] {
    return this.replayWithDispositions(records, entries, lastAppliedSeq).records;
  }

  private replayWithDispositions(
    records: readonly AccountRecord[],
    entries: readonly JournalEntry[],
    lastAppliedSeq = 0,
  ): ReplayResult {
    const aborted = new Set(
      entries.filter((entry) => entry.type === "abort").map((entry) => entry.id),
    );
    const seenOperations = new Set<string>();
    const dispositions: Omit<AccountOperationDisposition, "version">[] = [];
    let current = records;
    let highestApplied = lastAppliedSeq;
    for (const entry of entries) {
      if (
        entry.type !== "op" ||
        entry.seq === undefined ||
        entry.seq <= lastAppliedSeq ||
        aborted.has(entry.id) ||
        seenOperations.has(entry.opId)
      ) continue;
      seenOperations.add(entry.opId);

      const operation = entry.operation;
      let outcome: AccountOperationOutcome;
      if (operation.kind === "state") {
        if (highestApplied <= operation.baseLastAppliedSeq) {
          current = operation.records;
          outcome = "applied";
        } else {
          outcome = "skipped-stale";
        }
      } else if (operation.kind === "add") {
        const duplicate = current.some(
          (record) => record.id === operation.record.id || record.token === operation.record.token,
        );
        if (duplicate) {
          outcome = "rejected-duplicate";
        } else {
          current = applyNarrowOperation(current, operation);
          outcome = "applied";
        }
      } else {
        const targetPresent = current.some((record) => record.id === operation.id);
        current = applyNarrowOperation(current, operation);
        outcome = targetPresent || operation.kind === "remove" ? "applied" : "ignored-missing";
      }
      dispositions.push({ opId: entry.opId, outcome, seq: entry.seq });
      highestApplied = Math.max(highestApplied, entry.seq);
    }
    return { records: current, dispositions };
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
        opId: compactId,
        operation: {
          kind: "state",
          baseLastAppliedSeq: maximumSeq,
          records: replayed,
        },
      });
      const refreshedDisk = await this.readDiskSnapshot();
      const withCompact = await this.readJournal();
      const compact = withCompact.entries.find(
        (entry) => entry.type === "op" && entry.id === compactId,
      );
      if (compact === undefined || compact.type !== "op" || compact.seq === undefined) continue;
      const compactSeq = compact.seq;
      if (refreshedDisk.lastAppliedSeq >= compactSeq) continue;
      const publication = this.replayWithDispositions(
        refreshedDisk.records,
        withCompact.entries,
        refreshedDisk.lastAppliedSeq,
      );
      if (!(await this.persistCas(
        identity,
        serializeAccountFile(publication.records, compactSeq),
        publication.dispositions,
      ))) {
        await this.appendJournal({ type: "abort", id: compactId });
        continue;
      }
      await this.appendJournal({ type: "commit", id: compactId });
      await this.collectJournal();
      return publication.records;
    }
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing while reconciling the journal`,
    );
  }

  private async collectJournal(): Promise<void> {
    await this.replaceJournalWithEmpty();
  }

  protected async replaceJournalWithEmpty(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const collected = await this.withJournalLock(async () => {
        const journal = await this.readJournal();
        if (journal.liveContents.length > 0) {
          const liveEntries = await this.parseJournalContentsWithoutWarnings(journal.liveContents);
          const archiveMaximum = this.maximumSequence(liveEntries, 0);
          if (!(await this.rotateLiveJournal(journal.liveContents, archiveMaximum))) return false;
        }
        await this.retireLiveJournal();
        await this.deleteDeadArchives();
        await this.deleteOldVersions();
        return true;
      });
      if (collected) return;
    }
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing while garbage-collecting the journal; concurrent modification`,
    );
  }

  protected async rotateLiveJournal(
    expectedContents: string,
    maximumSequence: number,
  ): Promise<boolean> {
    if (await this.readJournalContents() !== expectedContents) return false;
    const archivePath = `${this.journalPath()}.archive-${String(maximumSequence).padStart(16, "0")}-${Date.now()}-${randomUUID()}`;
    try {
      await rename(this.journalPath(), archivePath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw new AccountStoreError(`Could not rotate accounts journal at ${this.journalPath()}`, {
        cause: error,
      });
    }

    try {
      const handle = await open(this.journalPath(), "wx", 0o600);
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw new AccountStoreError(`Could not create accounts journal at ${this.journalPath()}`, {
          cause: error,
        });
      }
    }
    return true;
  }

  private async retireLiveJournal(): Promise<void> {
    const contents = await this.readJournalFile(this.journalPath());
    if (contents === undefined) return;
    const entries = await this.parseJournalContentsWithoutWarnings(contents);
    const maximumSequence = this.maximumSequence(entries, 0);
    const archivePath = `${this.journalPath()}.archive-${String(maximumSequence).padStart(16, "0")}-${Date.now()}-${randomUUID()}`;
    try {
      // A second rename retires the newly-created empty live journal without
      // unlinking it. If a stale-lock peer appended in the meantime, those
      // bytes move intact into this archive instead of being discarded.
      await rename(this.journalPath(), archivePath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw new AccountStoreError(`Could not retire accounts journal at ${this.journalPath()}`, {
          cause: error,
        });
      }
    }
  }

  private async deleteDeadArchives(): Promise<void> {
    for (const archivePath of await this.journalArchivePaths()) {
      const contents = await this.readJournalFile(archivePath);
      if (contents === undefined) continue;
      const entries = await this.parseJournalContentsWithoutWarnings(contents);
      const archiveMaximum = this.maximumSequence(entries, 0);
      // Keep the disk-read seam at the deletion decision so process tests can
      // race the real boundary after the publication mechanism moved.
      await this.readDiskSnapshotDirect();
      // Recovery bytes are disposable only after a freshly selected immutable
      // authority has absorbed their complete sequence range.
      const authority = await this.readAuthoritativeVersionSnapshot();
      if (authority === undefined || archiveMaximum > authority.publicationSeq) continue;
      try {
        await rm(archivePath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw new AccountStoreError(`Could not delete accounts journal archive at ${archivePath}`, {
            cause: error,
          });
        }
      }
    }
  }

  private async deleteOldVersions(): Promise<void> {
    const authority = await this.readAuthoritativeVersionSnapshot();
    if (authority === undefined) return;
    const floor = Math.max(0, authority.publicationSeq - VERSION_RETENTION_DISTANCE);
    for (const candidate of await this.versionCandidates()) {
      if (candidate.publicationSeq >= floor) continue;
      try {
        await rm(candidate.path);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          throw new AccountStoreError(`Could not delete old accounts version at ${candidate.path}`, {
            cause: error,
          });
        }
      }
    }
  }

  private async readJournal(): Promise<JournalSnapshot> {
    // Read the live file before listing archives. If rotation races this read,
    // the old contents are observed either here or under their new archive
    // name (possibly both), but can never fall through the gap between them.
    const liveContents = await this.readJournalContents();
    const archivePaths = await this.journalArchivePaths();
    const snapshots: { readonly path: string; readonly contents: string }[] = [];
    for (const archivePath of archivePaths) {
      const contents = await this.readJournalFile(archivePath);
      if (contents !== undefined) snapshots.push({ path: archivePath, contents });
    }
    snapshots.push({ path: this.journalPath(), contents: liveContents });

    const entries: JournalEntry[] = [];
    for (const snapshot of snapshots) {
      const lines = snapshot.contents.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.length === 0) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          entries.push(parseJournalEntry(parsed));
        } catch (error) {
          const warningKey = `${snapshot.path}:${index + 1}:${line}`;
          if (!this.warnedJournalLines.has(warningKey)) {
            this.warnedJournalLines.add(warningKey);
            this.warn(
              new AccountStoreJournalWarning(
                `Ignored malformed accounts journal line ${index + 1} at ${snapshot.path}`,
                { cause: error },
              ),
            );
          }
        }
      }
    }
    entries.sort((left, right) => {
      const leftSequence = left.type === "op" ? left.seq ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const rightSequence = right.type === "op" ? right.seq ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      return leftSequence - rightSequence;
    });
    return { liveContents, entries };
  }

  private async readJournalContents(): Promise<string> {
    const contents = await this.readJournalFile(this.journalPath());
    return contents ?? "";
  }

  private async operationDisposition(
    opId: string,
  ): Promise<AccountOperationDisposition | undefined> {
    const dispositions = await this.readDispositions();
    return dispositions
      .filter((disposition) => disposition.opId === opId)
      .sort((left, right) => right.version - left.version)[0];
  }

  private async readDispositions(): Promise<readonly AccountOperationDisposition[]> {
    let contents: string;
    try {
      contents = await readFile(this.dispositionsPath(), "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw new AccountStoreError(
        `Could not read accounts operation dispositions at ${this.dispositionsPath()}`,
        { cause: error },
      );
    }

    const dispositions: AccountOperationDisposition[] = [];
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        dispositions.push(parseAccountOperationDisposition(parsed));
      } catch (error) {
        const warningKey = `${this.dispositionsPath()}:${index + 1}:${line}`;
        if (this.warnedJournalLines.has(warningKey)) continue;
        this.warnedJournalLines.add(warningKey);
        this.warn(new AccountStoreJournalWarning(
          `Ignored malformed accounts operation disposition line ${index + 1} at ${this.dispositionsPath()}`,
          { cause: error },
        ));
      }
    }
    return dispositions;
  }

  private async appendDispositions(
    drafts: readonly Omit<AccountOperationDisposition, "version">[],
    version: number,
  ): Promise<void> {
    if (drafts.length === 0) return;
    await this.withJournalLock(async () => {
      const existing = await this.readDispositions();
      const settled = new Set(existing.map((disposition) => disposition.opId));
      const additions = drafts.filter((draft) => !settled.has(draft.opId));
      if (additions.length === 0) return;

      let contents = "";
      try {
        contents = await readFile(this.dispositionsPath(), "utf-8");
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      const framing = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
      const lines = additions.map((draft) => JSON.stringify({ ...draft, version })).join("\n");
      try {
        const handle = await open(this.dispositionsPath(), "a", 0o600);
        try {
          await handle.chmod(0o600);
          await handle.appendFile(`${framing}${lines}\n`, "utf-8");
        } finally {
          await handle.close();
        }
      } catch (error) {
        throw new AccountStoreError(
          `Could not append accounts operation dispositions at ${this.dispositionsPath()}`,
          { cause: error },
        );
      }
    });
  }

  private async readJournalFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw new AccountStoreError(`Could not read accounts journal at ${path}`, { cause: error });
    }
  }

  private async journalArchivePaths(): Promise<string[]> {
    const journalPath = this.journalPath();
    const prefix = `${basename(journalPath)}.archive-`;
    let names: string[];
    try {
      names = await readdir(dirname(journalPath));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw new AccountStoreError(`Could not list accounts journal archives at ${journalPath}`, {
        cause: error,
      });
    }
    return names
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dirname(journalPath), name));
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
          await this.appendJournalBytes(handle, `${framed}${JSON.stringify(persisted)}\n`);
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

  /** Awaitable boundary for process-level append/rotation scheduling tests. */
  protected async appendJournalBytes(
    handle: Awaited<ReturnType<typeof open>>,
    contents: string,
  ): Promise<void> {
    await handle.appendFile(contents, "utf-8");
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

  private dispositionsPath(): string {
    // This receipt log is never rotated or collected. It grows by at most a
    // constant number of small records per mutation/publication attempt.
    return `${this.options.path}.dispositions`;
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

  protected async persistCas(
    _expected: FileIdentity,
    contents: string,
    dispositions: readonly Omit<AccountOperationDisposition, "version">[] = [],
  ): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new AccountStoreError("Could not parse generated accounts publication", { cause: error });
    }
    const publication = parseAccountFile(parsed);
    const publicationSeq = publication.lastAppliedSeq;
    if (publicationSeq === undefined) {
      throw new AccountStoreError("Accounts publication is missing its journal sequence");
    }

    const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    let versionPath = this.versionPath(publicationSeq);
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      await writeFile(temporaryPath, contents, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      // Preserve the observable pre-publication boundary used by process
      // tests, but identity no longer gates or authorizes a destructive rename.
      await this.captureIdentity();
      try {
        await link(temporaryPath, versionPath);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        versionPath = this.versionPath(publicationSeq, `${process.pid}.${randomUUID()}`);
        await link(temporaryPath, versionPath);
      }
    } catch (error) {
      await this.removeTemporary(temporaryPath, error);
      throw new AccountStoreError(`Could not persist accounts version for ${this.options.path}`, {
        cause: error,
      });
    }
    await this.removeTemporary(temporaryPath);

    const authority = await this.readAuthoritativeVersionSnapshot();
    const won = authority?.name === basename(versionPath);
    if (won) {
      // Record replay outcomes immediately after the immutable version link.
      // A crash before this point leaves journal bytes for the next publisher;
      // after this point the durable opId receipt is authoritative.
      await this.appendDispositions(dispositions, publicationSeq);
      // Convenience mirror only. A racing, torn, failed, or regressive mirror
      // is harmless because a store that observes versions never falls back to it.
      try {
        await writeFile(this.options.path, contents, { encoding: "utf-8", mode: 0o600 });
      } catch (error) {
        this.warn(new AccountStoreJournalWarning(
          `Could not update convenience accounts snapshot at ${this.options.path}`,
          { cause: error },
        ));
      }
    }
    return won;
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
    const creditsMatch = input.credits === undefined || sameCredits(
      candidate.credits,
      intended.credits,
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
    const authority = await this.readAuthoritativeVersionSnapshot();
    if (authority !== undefined) return authority;
    return this.readCanonicalSnapshot();
  }

  private async readCanonicalSnapshot(): Promise<DiskSnapshot> {
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
    return { records: file.accounts, lastAppliedSeq: file.lastAppliedSeq ?? 0, exists: true };
  }

  private async readAuthoritativeVersionSnapshot(): Promise<VersionSnapshot | undefined> {
    let observedVersions = false;
    for (let attempt = 1; attempt <= MAX_VERSION_SELECTION_ATTEMPTS; attempt += 1) {
      const candidates = [...await this.versionCandidates()].sort(
        (left, right) => right.publicationSeq - left.publicationSeq || right.name.localeCompare(left.name),
      );
      if (candidates.length === 0) {
        if (!observedVersions) return undefined;
        throw new AccountStoreError(
          `Could not select an authoritative accounts version at ${this.options.path}; versions disappeared during selection`,
        );
      }
      observedVersions = true;

      let authority: VersionSnapshot | undefined;
      for (const candidate of candidates) {
        let contents: string;
        try {
          contents = await readFile(candidate.path, "utf-8");
        } catch (error) {
          if (hasErrorCode(error, "ENOENT")) continue;
          throw new AccountStoreError(`Could not read accounts version at ${candidate.path}`, {
            cause: error,
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(contents);
        } catch (error) {
          throw new AccountStoreError(`Accounts version at ${candidate.path} is not valid JSON`, {
            cause: error,
          });
        }
        const file = parseAccountFile(parsed);
        const snapshot: VersionSnapshot = {
          name: candidate.name,
          path: candidate.path,
          publicationSeq: candidate.publicationSeq,
          records: file.accounts,
          lastAppliedSeq: file.lastAppliedSeq ?? 0,
          exists: true,
        };
        if (
          authority === undefined ||
          snapshot.publicationSeq > authority.publicationSeq ||
          (snapshot.publicationSeq === authority.publicationSeq &&
            (snapshot.lastAppliedSeq > authority.lastAppliedSeq ||
              (snapshot.lastAppliedSeq === authority.lastAppliedSeq && snapshot.name > authority.name)))
        ) authority = snapshot;
      }
      if (authority !== undefined) return authority;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new AccountStoreError(
      `Could not select an authoritative accounts version at ${this.options.path} after ${MAX_VERSION_SELECTION_ATTEMPTS} attempts`,
    );
  }

  private async versionCandidates(): Promise<readonly {
    readonly name: string;
    readonly path: string;
    readonly publicationSeq: number;
  }[]> {
    const extension = extname(this.options.path) || ".json";
    const stem = basename(this.options.path, extname(this.options.path));
    const prefix = `${stem}.v`;
    let names: string[];
    try {
      names = await readdir(dirname(this.options.path));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw new AccountStoreError(`Could not list accounts versions for ${this.options.path}`, {
        cause: error,
      });
    }
    return names.flatMap((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(extension)) return [];
      const body = name.slice(prefix.length, -extension.length);
      const sequenceText = body.split(".", 1)[0];
      if (sequenceText === undefined || !/^\d+$/.test(sequenceText)) return [];
      const publicationSeq = Number(sequenceText);
      if (!Number.isSafeInteger(publicationSeq)) return [];
      return [{ name, path: join(dirname(this.options.path), name), publicationSeq }];
    });
  }

  private versionPath(publicationSeq: number, suffix?: string): string {
    const extension = extname(this.options.path) || ".json";
    const stem = basename(this.options.path, extname(this.options.path));
    const suffixPart = suffix === undefined ? "" : `.${suffix}`;
    return join(dirname(this.options.path), `${stem}.v${publicationSeq}${suffixPart}${extension}`);
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
