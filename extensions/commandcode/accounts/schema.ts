/**
 * On-disk schema for the multi-account Command Code credential file
 * (default `~/.commandcode/omo-accounts.json`, overridable via
 * `COMMANDCODE_ACCOUNTS_FILE`). Untrusted JSON enters only through
 * `parseAccountFile`, which either returns a fully validated `AccountFile`
 * or throws a descriptive `AccountStoreError` — it never returns partial
 * state.
 */

export const ACCOUNTS_FILE_VERSION = 1;

/**
 * Maximum representable ECMAScript `Date` value in epoch milliseconds. Any
 * persisted timestamp beyond it (or non-integral, negative, or non-finite)
 * cannot round-trip through `new Date`/`toISOString` — it corrupts the file on
 * write (JSON turns Infinity/NaN into null) or poisons later date math with
 * `RangeError: Invalid Date`.
 */
export const MAX_EPOCH_MS = 8.64e15;

export interface AccountCredits {
  readonly monthly: number;
  readonly purchased: number;
  readonly free: number;
  /** Quota period end, epoch milliseconds. Finite integer in [0, 8.64e15]. */
  readonly periodEnd: number;
}

export interface AccountRecord {
  readonly id: string;
  readonly token: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly keyName?: string;
  readonly enabled: boolean;
  /** Cooldown deadline, epoch milliseconds; set by quarantine. Finite integer in [0, 8.64e15]. */
  readonly retryAt?: number;
  /** ISO timestamp of when the account was added. */
  readonly createdAt: string;
  readonly credits?: AccountCredits;
}

/** Input accepted by `AccountStore.add`; defaults are applied at the boundary. */
export interface AccountRecordInput {
  readonly id: string;
  readonly token: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly keyName?: string;
  readonly enabled?: boolean;
  readonly retryAt?: number;
  readonly createdAt?: string;
  readonly credits?: AccountCredits;
}

export interface AccountFile {
  readonly version: typeof ACCOUNTS_FILE_VERSION;
  readonly accounts: readonly AccountRecord[];
  /** Highest journal sequence incorporated by this state snapshot. */
  readonly lastAppliedSeq?: number;
}

/** Domain error for every accounts-file failure: parse, IO, or invariant. */
export class AccountStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AccountStoreError";
  }
}

/** Non-fatal typed diagnostic emitted when a malformed journal line is skipped. */
export class AccountStoreJournalWarning extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AccountStoreJournalWarning";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AccountStoreError(`Expected ${context} field "${key}" to be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AccountStoreError(`Expected ${context} field "${key}" to be a non-empty string`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, context: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new AccountStoreError(`Expected ${context} field "${key}" to be a boolean`);
  }
  return value;
}

function isValidEpochMs(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_EPOCH_MS
  );
}

/**
 * Optional epoch-milliseconds timestamp (`retryAt`). Absent is fine; anything
 * present must be a finite integer in [0, 8.64e15] — null, negatives,
 * Infinity and overflowed values are all rejected here so a corrupted file
 * can never enter the store.
 */
function optionalTimestamp(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!isValidEpochMs(value)) {
    throw new AccountStoreError(
      `Expected ${context} field "${key}" to be a finite integer epoch-milliseconds timestamp in [0, ${MAX_EPOCH_MS}]`,
    );
  }
  return value;
}

/** Required epoch-milliseconds timestamp (`credits.periodEnd`); see `optionalTimestamp`. */
function requiredTimestamp(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (!isValidEpochMs(value)) {
    throw new AccountStoreError(
      `Expected ${context} field "credits.${key}" to be a finite integer epoch-milliseconds timestamp in [0, ${MAX_EPOCH_MS}]`,
    );
  }
  return value;
}

function parseCredits(value: unknown, context: string): AccountCredits {
  if (!isRecord(value)) {
    throw new AccountStoreError(`Expected ${context} field "credits" to be an object`);
  }
  return {
    monthly: requiredCreditsNumber(value, "monthly", context),
    purchased: requiredCreditsNumber(value, "purchased", context),
    free: requiredCreditsNumber(value, "free", context),
    periodEnd: requiredTimestamp(value, "periodEnd", context),
  };
}

function requiredCreditsNumber(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AccountStoreError(
      `Expected ${context} field "credits.${key}" to be a finite non-negative number`,
    );
  }
  return value;
}

function parseAccountRecord(value: unknown, index: number): AccountRecord {
  const context = `accounts[${index}]`;
  if (!isRecord(value)) {
    throw new AccountStoreError(`Expected ${context} entry to be an object`);
  }
  const createdAt = requiredString(value, "createdAt", context);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new AccountStoreError(`Expected ${context} field "createdAt" to be an ISO timestamp`);
  }
  const creditsValue = value["credits"];
  return {
    id: requiredString(value, "id", context),
    token: requiredString(value, "token", context),
    userId: optionalString(value, "userId", context),
    userName: optionalString(value, "userName", context),
    keyName: optionalString(value, "keyName", context),
    enabled: optionalBoolean(value, "enabled", context) ?? true,
    retryAt: optionalTimestamp(value, "retryAt", context),
    createdAt,
    credits: creditsValue === undefined ? undefined : parseCredits(creditsValue, context),
  };
}

/**
 * Parse untrusted JSON into a validated `AccountFile`. Duplicate ids and
 * duplicate tokens are rejected so the pool can treat `id` and `token` as
 * identity keys.
 */
export function parseAccountFile(value: unknown): AccountFile {
  if (!isRecord(value)) {
    throw new AccountStoreError("Expected accounts file to be a JSON object");
  }
  if (value["version"] !== ACCOUNTS_FILE_VERSION) {
    throw new AccountStoreError(`Expected accounts file version ${ACCOUNTS_FILE_VERSION}`);
  }
  const accountsValue = value["accounts"];
  if (!Array.isArray(accountsValue)) {
    throw new AccountStoreError('Expected accounts file field "accounts" to be an array');
  }

  const accounts = accountsValue.map((entry, index) => parseAccountRecord(entry, index));

  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  for (const account of accounts) {
    if (seenIds.has(account.id)) {
      throw new AccountStoreError(`Duplicate account id "${account.id}"`);
    }
    seenIds.add(account.id);
    if (seenTokens.has(account.token)) {
      // Reference the duplicate's account id only: embedding any token
      // substring (even a suffix) leaks credential material into error output.
      throw new AccountStoreError(`Duplicate account token (account id: ${account.id})`);
    }
    seenTokens.add(account.token);
  }

  const lastAppliedSeqValue = value["lastAppliedSeq"];
  if (
    lastAppliedSeqValue !== undefined &&
    (typeof lastAppliedSeqValue !== "number" ||
      !Number.isSafeInteger(lastAppliedSeqValue) ||
      lastAppliedSeqValue < 0)
  ) {
    throw new AccountStoreError(
      'Expected accounts file field "lastAppliedSeq" to be a non-negative safe integer',
    );
  }

  return lastAppliedSeqValue === undefined
    ? { version: ACCOUNTS_FILE_VERSION, accounts }
    : { version: ACCOUNTS_FILE_VERSION, accounts, lastAppliedSeq: lastAppliedSeqValue };
}

function assertWritableEpochMs(value: number, field: string): void {
  if (!isValidEpochMs(value)) {
    throw new AccountStoreError(
      `Refusing to persist ${field}: ${String(value)} is not a finite integer epoch-milliseconds timestamp in [0, ${MAX_EPOCH_MS}]`,
    );
  }
}

/**
 * Serialize records to the canonical on-disk form (pretty-printed, trailing
 * newline). Refuses to serialize timestamps outside the representable epoch
 * range: JSON.stringify turns Infinity/NaN into null and overflows would fail
 * the load boundary, so writing one would replace a valid file with a corrupt
 * one. The throw happens before any caller touches the filesystem.
 */
export function serializeAccountFile(
  accounts: readonly AccountRecord[],
  lastAppliedSeq?: number,
): string {
  for (const account of accounts) {
    if (account.retryAt !== undefined) {
      assertWritableEpochMs(account.retryAt, `account "${account.id}" field "retryAt"`);
    }
    if (account.credits !== undefined) {
      assertWritableEpochMs(
        account.credits.periodEnd,
        `account "${account.id}" field "credits.periodEnd"`,
      );
    }
  }
  if (
    lastAppliedSeq !== undefined &&
    (!Number.isSafeInteger(lastAppliedSeq) || lastAppliedSeq < 0)
  ) {
    throw new AccountStoreError(
      "Refusing to persist lastAppliedSeq: expected a non-negative safe integer",
    );
  }
  const file: AccountFile =
    lastAppliedSeq === undefined
      ? { version: ACCOUNTS_FILE_VERSION, accounts }
      : { version: ACCOUNTS_FILE_VERSION, accounts, lastAppliedSeq };
  return `${JSON.stringify(file, null, 2)}\n`;
}
