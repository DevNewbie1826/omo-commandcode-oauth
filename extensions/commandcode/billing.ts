export const DEFAULT_API_BASE = "https://api.commandcode.ai";
export const DEFAULT_BILLING_TTL_MS = 3_600_000;

export class BillingParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillingParseError";
  }
}

export type BillingSnapshot = {
  readonly monthly: number;
  readonly purchased: number;
  readonly free: number;
  readonly periodEnd: number;
};

export type FetchBillingSnapshotOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly apiBase?: string;
  readonly now?: () => number;
};

export type BillingCache = {
  get(apiKey: string): BillingSnapshot | undefined;
  set(apiKey: string, snapshot: BillingSnapshot): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BillingParseError(`Expected ${key} to be a finite number`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BillingParseError(`Expected ${key} to be a non-empty string`);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  let result = value;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

function resolveApiBase(apiBase: string | undefined): string {
  const fromEnv = process.env.COMMANDCODE_API_BASE;
  const raw = apiBase ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_API_BASE);
  return trimTrailingSlash(raw);
}

function parseTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_BILLING_TTL_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_BILLING_TTL_MS;
  return Number(raw);
}

function parseCredits(value: unknown): {
  readonly monthly: number;
  readonly purchased: number;
  readonly free: number;
} {
  if (!isRecord(value)) throw new BillingParseError("Expected credits response to be an object");
  const credits = value.credits;
  if (!isRecord(credits)) throw new BillingParseError("Expected credits to be an object");
  return {
    monthly: numberField(credits, "monthlyCredits"),
    purchased: numberField(credits, "purchasedCredits"),
    free: numberField(credits, "freeCredits"),
  };
}

function parseSubscriptions(value: unknown): number {
  if (!isRecord(value)) throw new BillingParseError("Expected subscriptions response to be an object");
  const record = isRecord(value.data) ? value.data : value;
  stringField(record, "planId");
  stringField(record, "status");
  stringField(record, "currentPeriodStart");
  const periodEnd = Date.parse(stringField(record, "currentPeriodEnd"));
  if (Number.isNaN(periodEnd)) {
    throw new BillingParseError("Expected currentPeriodEnd to be an ISO timestamp");
  }
  return periodEnd;
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new BillingParseError(`${label} request failed: ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error: unknown) {
    throw new BillingParseError(`${label} response was not valid JSON`, { cause: error });
  }
}

export async function fetchBillingSnapshot(
  options: FetchBillingSnapshotOptions,
): Promise<BillingSnapshot | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = resolveApiBase(options.apiBase);
  const headers = { Authorization: `Bearer ${options.apiKey}` };

  try {
    const creditsResponse = await fetchImpl(`${apiBase}/alpha/billing/credits`, {
      method: "GET",
      headers,
    });
    const creditsPayload = await readJson(creditsResponse, "credits");
    const subscriptionsResponse = await fetchImpl(`${apiBase}/alpha/billing/subscriptions`, {
      method: "GET",
      headers,
    });
    const subscriptionsPayload = await readJson(subscriptionsResponse, "subscriptions");
    const credits = parseCredits(creditsPayload);
    return {
      monthly: credits.monthly,
      purchased: credits.purchased,
      free: credits.free,
      periodEnd: parseSubscriptions(subscriptionsPayload),
    };
  } catch (_error: unknown) {
    return undefined;
  }
}

export function createBillingCache(
  options: {
    readonly ttlMs?: number;
    readonly now?: () => number;
  } = {},
): BillingCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? parseTtlMs(process.env.COMMANDCODE_BILLING_TTL_MS);
  const entries = new Map<string, { readonly snapshot: BillingSnapshot; readonly storedAt: number }>();

  return {
    get(apiKey: string): BillingSnapshot | undefined {
      const entry = entries.get(apiKey);
      if (entry === undefined) return undefined;
      if (now() >= entry.storedAt + ttlMs) {
        entries.delete(apiKey);
        return undefined;
      }
      return entry.snapshot;
    },
    set(apiKey: string, snapshot: BillingSnapshot): void {
      entries.set(apiKey, { snapshot, storedAt: now() });
    },
  };
}
