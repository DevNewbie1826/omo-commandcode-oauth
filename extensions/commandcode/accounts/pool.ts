import { AccountStoreError, type AccountCredits, type AccountRecord } from "./schema.js";
import type { AccountStore } from "./store.js";

export const DEFAULT_EXPIRY_WINDOW_MS = 86_400_000;

export function resolveExpiryWindowMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env["COMMANDCODE_EXPIRY_WINDOW_MS"];
  if (raw === undefined || raw.length === 0) return DEFAULT_EXPIRY_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AccountStoreError(
      `Expected env COMMANDCODE_EXPIRY_WINDOW_MS to be a positive integer, got "${raw}"`,
    );
  }
  return parsed;
}

export class NoCommandCodeAccountsError extends Error {
  constructor() {
    super("No Command Code accounts");
    this.name = "NoCommandCodeAccountsError";
  }
}

export interface AccountLease {
  readonly id: string;
  readonly token: string;
  readonly credits?: AccountCredits;
}

export interface AccountPoolOptions {
  readonly store: AccountStore;
  readonly now?: () => number;
  readonly expiryWindowMs?: number;
}

type AccountWithCredits = AccountRecord & { readonly credits: AccountCredits };

function isTierZero(
  account: AccountRecord,
  now: number,
  expiryWindowMs: number,
): account is AccountWithCredits {
  const credits = account.credits;
  return credits !== undefined &&
    credits.monthly + credits.free > 0 &&
    credits.periodEnd > now &&
    credits.periodEnd - now < expiryWindowMs;
}

export class AccountPool {
  private readonly store: AccountStore;
  private readonly clock: () => number;
  private readonly expiryWindowMs: number;
  private readonly creditsByToken = new Map<string, AccountCredits>();

  constructor(options: AccountPoolOptions) {
    this.store = options.store;
    this.clock = options.now ?? Date.now;
    this.expiryWindowMs = options.expiryWindowMs ?? resolveExpiryWindowMs();
  }

  updateCredits(token: string, credits: AccountCredits): void {
    this.creditsByToken.set(token, credits);
  }

  async ordered(now: number = this.clock()): Promise<readonly AccountLease[]> {
    const loaded = await this.store.load();
    const enabled = loaded.filter((account) => account.enabled).map((account) => {
      if (!this.creditsByToken.has(account.token) && account.credits !== undefined) {
        this.creditsByToken.set(account.token, account.credits);
      }
      const credits = this.creditsByToken.get(account.token);
      return credits === undefined ? account : { ...account, credits };
    });
    if (enabled.length === 0) throw new NoCommandCodeAccountsError();

    const tierZero = enabled
      .filter((account): account is AccountWithCredits =>
        isTierZero(account, now, this.expiryWindowMs),
      )
      .sort((left, right) => left.credits.periodEnd - right.credits.periodEnd);
    const tierZeroIds = new Set(tierZero.map((account) => account.id));
    return [...tierZero, ...enabled.filter((account) => !tierZeroIds.has(account.id))].map(
      ({ id, token, credits }) => ({ id, token, credits }),
    );
  }
}
