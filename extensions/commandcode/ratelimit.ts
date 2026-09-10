const RATE_LIMIT_WINDOWS = ["fiveHour", "daily", "weekly"] as const;
const USAGE_LIMIT = /usage limit for your plan/i;
const RESETS_AT = /resets at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i;

export type RateLimitWindow = (typeof RATE_LIMIT_WINDOWS)[number];
export type CooldownReason = "rate-limit" | "credits-exhausted";

export type CooldownDecision = {
  readonly retryAtMs: number | null;
  readonly reason: CooldownReason;
  readonly window?: RateLimitWindow;
};

export type ParseCooldownInput = {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Headers | Readonly<Record<string, string>>;
  readonly now?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) return parsed;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return { error: { message: body } };
      return { error: { message: body } };
    }
    return { error: { message: body } };
  }
  if (isRecord(body)) return body;
  return {};
}

function parseWindow(value: unknown): RateLimitWindow | undefined {
  for (const window of RATE_LIMIT_WINDOWS) {
    if (value === window) return window;
  }
  return undefined;
}

function unixSecondsToMs(value: unknown): number | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined) return undefined;
  return seconds * 1000;
}

function isCreditCode(code: string | undefined): boolean {
  return code === "insufficient_credits" || code === "credits_exhausted" || code === "quota_exceeded";
}

function messageIsoMs(message: string | undefined): number | undefined {
  if (message === undefined) return undefined;
  const match = RESETS_AT.exec(message);
  const iso = match?.[1];
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

function headerValue(
  headers: Headers | Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null || value.length === 0 ? undefined : value;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const value = headers[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function parseRetryAfter(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return now + Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

function resetMsFrom(
  record: Record<string, unknown>,
  error: Record<string, unknown> | undefined,
  rateLimit: Record<string, unknown> | undefined,
): number | undefined {
  return unixSecondsToMs(rateLimit?.reset) ?? unixSecondsToMs(error?.reset) ?? unixSecondsToMs(record.reset);
}

export function parseCooldown(input: ParseCooldownInput): CooldownDecision | null {
  const now = input.now ?? Date.now();
  const record = asBodyRecord(input.body);
  const error = isRecord(record.error) ? record.error : undefined;
  const nestedRateLimit = error === undefined ? undefined : error.rateLimit;
  const rateLimit = isRecord(nestedRateLimit)
    ? nestedRateLimit
    : isRecord(record.rateLimit)
      ? record.rateLimit
      : undefined;
  const code = stringValue(error?.code) ?? stringValue(record.code);
  const message = stringValue(error?.message) ?? stringValue(record.message);
  const errorType = stringValue(error?.type);

  if (input.status === 402 || isCreditCode(code)) {
    return {
      retryAtMs: resetMsFrom(record, error, rateLimit) ?? null,
      reason: "credits-exhausted",
    };
  }

  const isRateLimit =
    input.status === 429 ||
    code === "RATE_LIMITED" ||
    code === "rate_limit_error" ||
    errorType === "rate_limit_error" ||
    (message !== undefined && USAGE_LIMIT.test(message));
  if (!isRateLimit) return null;

  const retryAfter = headerValue(input.headers, "retry-after");
  const retryAtMs =
    unixSecondsToMs(rateLimit?.reset) ??
    messageIsoMs(message) ??
    (retryAfter === undefined ? undefined : parseRetryAfter(retryAfter, now)) ??
    null;
  const window = parseWindow(rateLimit?.window);
  if (window === undefined) return { retryAtMs, reason: "rate-limit" };
  return { retryAtMs, reason: "rate-limit", window };
}
