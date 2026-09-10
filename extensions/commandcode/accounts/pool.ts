/**
 * `AccountPool` selects accounts from an `AccountStore` with tiered,
 * session-sticky rotation:
 *
 * - Healthy means enabled, cooldown expired (`retryAt` undefined or <= now),
 *   and not excluded.
 * - Tier 0: accounts with a credits snapshot where monthly+free > 0 and the
 *   period ends strictly after now and within `expiryWindowMs` (env
 *   `COMMANDCODE_EXPIRY_WINDOW_MS`, default 24h) — sorted by `periodEnd`
 *   ascending, so the account about to expire first gets drained first.
 *   Stale snapshots (`periodEnd` <= now) stay in tier 1.
 * - Tier 1: every other healthy account, in file order, except that a healthy
 *   `preferredId` (selection option, e.g. a host-pinned key) sorts first — the
 *   weakest selection signal: it never displaces a sticky binding or a tier-0
 *   candidate, and an unhealthy or excluded preferred id is ignored.
 * - Sticky: a bound sessionId keeps its account while it stays healthy;
 *   otherwise the first candidate in tier order is picked and bound.
 * - Quarantine raises an account's `retryAt` (never lowers it) and unbinds
 *   every session from it. There is deliberately no advancing cursor: once
 *   all cooldowns lapse, selection naturally falls back to the first account
 *   in tier order (== file order when no credits are involved).
 */
import type { AccountCredits, AccountRecord } from "./schema.js";
import { AccountStoreError } from "./schema.js";
import type { AccountStore } from "./store.js";

export const DEFAULT_EXPIRY_WINDOW_MS = 86_400_000;

/** Resolve the tier-0 expiry window from the environment; invalid values are rejected loudly. */
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

/** Thrown by `AccountPool.next` when no account is healthy. */
export class NoHealthyAccountsError extends Error {
  /** Earliest future `retryAt` across enabled accounts; undefined when none. */
  readonly retryAt: number | undefined;

  constructor(retryAt: number | undefined) {
    super(
      retryAt === undefined
        ? "No healthy Command Code accounts available"
        : `No healthy Command Code accounts available; next retry at ${new Date(retryAt).toISOString()}`,
    );
    this.name = "NoHealthyAccountsError";
    this.retryAt = retryAt;
  }
}

export interface AccountLease {
  readonly id: string;
  readonly token: string;
  readonly credits?: AccountCredits;
  /** Quarantine this account until `retryAtMs` (raises an existing cooldown) and unbind its sessions. */
  quarantine(retryAtMs: number): Promise<void>;
  /** Release the session binding for the lease, if still bound to this account. */
  unbind(): void;
}

export interface AccountPoolOptions {
  readonly store: AccountStore;
  /** Injected clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Tier-0 expiry window in ms; defaults to `COMMANDCODE_EXPIRY_WINDOW_MS` else 24h. */
  readonly expiryWindowMs?: number;
}

export interface SelectionOptions {
  readonly sessionId?: string;
  readonly excluded?: ReadonlySet<string>;
  /**
   * Weakest-signal tiebreaker (e.g. a host-pinned account): when healthy, it
   * sorts ahead of other tier-1 candidates — AFTER any healthy sticky binding
   * and all tier-0 candidates, which always win over it.
   */
  readonly preferredId?: string;
}

/** An account known to carry a credits snapshot (narrowed by the tier-0 predicate). */
type ExpiringAccount = AccountRecord & { readonly credits: AccountCredits };

function isHealthy(
  record: AccountRecord,
  nowMs: number,
  excluded: ReadonlySet<string> | undefined,
): boolean {
  if (!record.enabled) return false;
  const retryAt = record.retryAt;
  if (retryAt !== undefined && retryAt > nowMs) return false;
  return !(excluded?.has(record.id) ?? false);
}

function isExpiringTier(
  record: AccountRecord,
  nowMs: number,
  expiryWindowMs: number,
): record is ExpiringAccount {
  const credits = record.credits;
  if (credits === undefined) return false;
  return (
    credits.monthly + credits.free > 0 &&
    credits.periodEnd > nowMs &&
    credits.periodEnd - nowMs < expiryWindowMs
  );
}

function byPeriodEndAsc(left: ExpiringAccount, right: ExpiringAccount): number {
  return left.credits.periodEnd - right.credits.periodEnd;
}

export class AccountPool {
  private readonly store: AccountStore;
  private readonly clock: () => number;
  private readonly expiryWindowMs: number;
  private readonly sessionBindings = new Map<string, string>();

  constructor(options: AccountPoolOptions) {
    this.store = options.store;
    this.clock = options.now ?? (() => Date.now());
    this.expiryWindowMs = options.expiryWindowMs ?? resolveExpiryWindowMs();
  }

  /** Select a healthy account, honoring sticky session bindings. Throws `NoHealthyAccountsError` when none qualify. */
  async next(nowMs: number = this.clock(), options: SelectionOptions = {}): Promise<AccountLease> {
    const records = await this.store.load();
    const excluded = options.excluded;

    const healthy = records.filter((record) => isHealthy(record, nowMs, excluded));
    const expiring = healthy
      .filter((record): record is ExpiringAccount =>
        isExpiringTier(record, nowMs, this.expiryWindowMs),
      )
      .sort(byPeriodEndAsc);
    const expiringIds = new Set(expiring.map((record) => record.id));
    const tier1 = healthy.filter((record) => !expiringIds.has(record.id));
    const preferred = tier1.filter((record) => record.id === options.preferredId);
    const ordered = [
      ...expiring,
      ...preferred,
      ...tier1.filter((record) => record.id !== options.preferredId),
    ];

    const boundId =
      options.sessionId === undefined ? undefined : this.sessionBindings.get(options.sessionId);
    const sticky = boundId === undefined ? undefined : ordered.find((record) => record.id === boundId);

    const chosen = sticky ?? ordered[0];
    if (chosen === undefined) {
      throw this.noHealthyError(records, nowMs);
    }

    if (options.sessionId !== undefined && sticky === undefined) {
      this.sessionBindings.set(options.sessionId, chosen.id);
    }
    return this.leaseFor(chosen, options.sessionId);
  }

  /**
   * Quarantine an account: `retryAt` becomes `max(existing, retryAtMs)` (persisted
   * to the store), and every sessionId bound to the account is unbound.
   */
  async quarantine(accountId: string, retryAtMs: number): Promise<void> {
    await this.store.mutate((records) => {
      let found = false;
      const next = records.map((record) => {
        if (record.id !== accountId) return record;
        found = true;
        const existing = record.retryAt;
        return {
          ...record,
          retryAt: existing === undefined ? retryAtMs : Math.max(existing, retryAtMs),
        };
      });
      if (!found) {
        throw new AccountStoreError(`Unknown account id: ${accountId}`);
      }
      return next;
    });

    for (const [sessionId, boundId] of this.sessionBindings) {
      if (boundId === accountId) this.sessionBindings.delete(sessionId);
    }
  }

  private leaseFor(record: AccountRecord, sessionId: string | undefined): AccountLease {
    return {
      id: record.id,
      token: record.token,
      credits: record.credits,
      quarantine: (retryAtMs: number) => this.quarantine(record.id, retryAtMs),
      unbind: () => {
        if (sessionId !== undefined && this.sessionBindings.get(sessionId) === record.id) {
          this.sessionBindings.delete(sessionId);
        }
      },
    };
  }

  private noHealthyError(records: readonly AccountRecord[], nowMs: number): NoHealthyAccountsError {
    let minRetryAt: number | undefined;
    for (const record of records) {
      if (!record.enabled) continue;
      const retryAt = record.retryAt;
      if (retryAt === undefined || retryAt <= nowMs) continue;
      minRetryAt = minRetryAt === undefined ? retryAt : Math.min(minRetryAt, retryAt);
    }
    return new NoHealthyAccountsError(minRetryAt);
  }
}
