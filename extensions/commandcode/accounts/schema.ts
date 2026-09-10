/**
 * On-disk schema for the multi-account Command Code credential file
 * (default `~/.commandcode/omo-accounts.json`, overridable via
 * `COMMANDCODE_ACCOUNTS_FILE`). Untrusted JSON enters only through
 * `parseAccountFile`, which either returns a fully validated `AccountFile`
 * or throws a descriptive `AccountStoreError` — it never returns partial
 * state.
 */

export const ACCOUNTS_FILE_VERSION = 1;

export interface AccountCredits {
  readonly monthly: number;
  readonly purchased: number;
  readonly free: number;
  /** Quota period end, milliseconds since the Unix epoch. */
  readonly periodEnd: number;
}

export interface AccountRecord {
  readonly id: string;
  readonly token: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly keyName?: string;
  readonly enabled: boolean;
  /** Cooldown deadline, milliseconds since the Unix epoch; set by quarantine. */
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
}

/** Domain error for every accounts-file failure: parse, IO, or invariant. */
export class AccountStoreError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "AccountStoreError";
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

function optionalNumber(record: Record<string, unknown>, key: string, context: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AccountStoreError(`Expected ${context} field "${key}" to be a finite number`);
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
    periodEnd: requiredCreditsNumber(value, "periodEnd", context),
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
    retryAt: optionalNumber(value, "retryAt", context),
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
      throw new AccountStoreError(`Duplicate account token (…${account.token.slice(-4)})`);
    }
    seenTokens.add(account.token);
  }

  return { version: ACCOUNTS_FILE_VERSION, accounts };
}

/** Serialize records to the canonical on-disk form (pretty-printed, trailing newline). */
export function serializeAccountFile(accounts: readonly AccountRecord[]): string {
  const file: AccountFile = { version: ACCOUNTS_FILE_VERSION, accounts };
  return `${JSON.stringify(file, null, 2)}\n`;
}
