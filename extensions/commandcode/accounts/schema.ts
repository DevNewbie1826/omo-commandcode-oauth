export const ACCOUNTS_FILE_VERSION = 1;
export const MAX_EPOCH_MS = 8.64e15;

export interface AccountCredits {
  readonly monthly: number;
  readonly purchased: number;
  readonly free: number;
  readonly periodEnd: number;
}

export interface AccountRecord {
  readonly id: string;
  readonly token: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly keyName?: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly credits?: AccountCredits;
}

export interface AccountRecordInput {
  readonly id: string;
  readonly token: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly keyName?: string;
  readonly enabled?: boolean;
  readonly createdAt?: string;
  readonly credits?: AccountCredits;
}

export interface AccountFile {
  readonly version: typeof ACCOUNTS_FILE_VERSION;
  readonly accounts: readonly AccountRecord[];
}

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

function optionalString(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AccountStoreError(`Expected ${context} field "${key}" to be a non-empty string`);
  }
  return value;
}

function creditsNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AccountStoreError(
      `Expected ${context} field "credits.${key}" to be a finite non-negative number`,
    );
  }
  return value;
}

function validEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

function parseCredits(value: unknown, context: string): AccountCredits {
  if (!isRecord(value)) {
    throw new AccountStoreError(`Expected ${context} field "credits" to be an object`);
  }
  const periodEnd = value["periodEnd"];
  if (!validEpoch(periodEnd)) {
    throw new AccountStoreError(`Expected ${context} field "credits.periodEnd" to be a valid timestamp`);
  }
  return {
    monthly: creditsNumber(value, "monthly", context),
    purchased: creditsNumber(value, "purchased", context),
    free: creditsNumber(value, "free", context),
    periodEnd,
  };
}

function parseAccount(value: unknown, index: number): AccountRecord {
  const context = `accounts[${index}]`;
  if (!isRecord(value)) throw new AccountStoreError(`Expected ${context} entry to be an object`);
  const createdAt = requiredString(value, "createdAt", context);
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new AccountStoreError(`Expected ${context} field "createdAt" to be an ISO timestamp`);
  }
  const enabled = value["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new AccountStoreError(`Expected ${context} field "enabled" to be a boolean`);
  }
  const credits = value["credits"];
  return {
    id: requiredString(value, "id", context),
    token: requiredString(value, "token", context),
    userId: optionalString(value, "userId", context),
    userName: optionalString(value, "userName", context),
    keyName: optionalString(value, "keyName", context),
    enabled: enabled ?? true,
    createdAt,
    credits: credits === undefined ? undefined : parseCredits(credits, context),
  };
}

export function parseAccountFile(value: unknown): AccountFile {
  if (!isRecord(value)) throw new AccountStoreError("Expected accounts file to be a JSON object");
  if (value["version"] !== ACCOUNTS_FILE_VERSION) {
    throw new AccountStoreError(`Expected accounts file version ${ACCOUNTS_FILE_VERSION}`);
  }
  const rawAccounts = value["accounts"];
  if (!Array.isArray(rawAccounts)) {
    throw new AccountStoreError('Expected accounts file field "accounts" to be an array');
  }
  const accounts = rawAccounts.map(parseAccount);
  const ids = new Set<string>();
  const tokens = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new AccountStoreError(`Duplicate account id "${account.id}"`);
    if (tokens.has(account.token)) {
      throw new AccountStoreError(`Duplicate account token (account id: ${account.id})`);
    }
    ids.add(account.id);
    tokens.add(account.token);
  }
  return { version: ACCOUNTS_FILE_VERSION, accounts };
}

export function parseAccountRecords(value: unknown): readonly AccountRecord[] {
  return parseAccountFile({ version: ACCOUNTS_FILE_VERSION, accounts: value }).accounts;
}

export function serializeAccountFile(accounts: readonly AccountRecord[]): string {
  return `${JSON.stringify({ version: ACCOUNTS_FILE_VERSION, accounts }, null, 2)}\n`;
}
