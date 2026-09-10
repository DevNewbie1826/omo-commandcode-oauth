import { describe, expect, it } from "vitest";
import { parseCooldown, type ParseCooldownInput } from "../extensions/commandcode/ratelimit.js";

const RESET_SECONDS = 1_758_000_000;
const RESET_MS = RESET_SECONDS * 1000;
const MESSAGE_ISO = "2026-09-12T05:00:00Z";
const MESSAGE_ISO_MS = Date.parse(MESSAGE_ISO);
const HTTP_DATE = "Wed, 16 Sep 2026 05:00:00 GMT";
const HTTP_DATE_MS = Date.parse(HTTP_DATE);
const NOW_MS = 1_700_000_000_000;
const MAX_DATE_MS = 8.64e15;
const MAX_DATE_SECONDS = MAX_DATE_MS / 1000;
const FAR_FUTURE_HTTP_DATE = "Sun, 14 Sep 275760 00:00:00 GMT";
const OVERFLOW_RETRY_AFTER = "9".repeat(309);
/** Reviewer schedule: unix-seconds with a sub-ms fraction after *1000. */
const FRACTIONAL_RESET_SECONDS = 1_700_000_060.1234;
const FRACTIONAL_RESET_MS = Math.floor(FRACTIONAL_RESET_SECONDS * 1000);

describe("parseCooldown", () => {
  it("Given a 429 RATE_LIMITED body with fiveHour reset, When parseCooldown runs, Then retryAtMs is reset seconds as ms with rate-limit window", () => {
    const decision = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: "too many requests",
          rateLimit: { window: "fiveHour", reset: RESET_SECONDS },
        },
      },
    });

    expect(decision).toEqual({
      retryAtMs: RESET_MS,
      reason: "rate-limit",
      window: "fiveHour",
    });
  });

  it("Given a 429 RATE_LIMITED message with resets-at ISO and no rateLimit object, When parseCooldown runs, Then retryAtMs is the parsed ISO instant", () => {
    const decision = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
        },
      },
    });

    expect(decision).toEqual({
      retryAtMs: MESSAGE_ISO_MS,
      reason: "rate-limit",
    });
  });

  it("Given a 429 with Retry-After delay-seconds, When parseCooldown runs with an injected now, Then retryAtMs is now plus that delay", () => {
    const decision = parseCooldown({
      status: 429,
      body: {},
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });

    expect(decision).toEqual({
      retryAtMs: NOW_MS + 30_000,
      reason: "rate-limit",
    });
  });

  it("Given a 429 with Retry-After HTTP-date, When parseCooldown runs, Then retryAtMs is the parsed date", () => {
    const decision = parseCooldown({
      status: 429,
      body: {},
      headers: { "Retry-After": HTTP_DATE },
    });

    expect(decision).toEqual({
      retryAtMs: HTTP_DATE_MS,
      reason: "rate-limit",
    });
  });

  it("Given rateLimit.reset, message ISO, and Retry-After together, When parseCooldown runs, Then body reset wins over message ISO over Retry-After", () => {
    const withReset = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
          rateLimit: { window: "daily", reset: RESET_SECONDS },
        },
      },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });
    const withMessage = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
        },
      },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });

    expect(withReset).toEqual({
      retryAtMs: RESET_MS,
      reason: "rate-limit",
      window: "daily",
    });
    expect(withMessage).toEqual({
      retryAtMs: MESSAGE_ISO_MS,
      reason: "rate-limit",
    });
  });

  it("Given status 402 with no reset, When parseCooldown runs, Then reason is credits-exhausted and retryAtMs is null", () => {
    const decision = parseCooldown({
      status: 402,
      body: { error: { message: "pay up" } },
    });

    expect(decision).toEqual({
      retryAtMs: null,
      reason: "credits-exhausted",
    });
  });

  it("Given body codes insufficient_credits, credits_exhausted, and quota_exceeded, When parseCooldown runs, Then each is credits-exhausted and reset is honored when present", () => {
    expect(
      parseCooldown({
        status: 200,
        body: { error: { code: "insufficient_credits", rateLimit: { reset: RESET_SECONDS } } },
      }),
    ).toEqual({
      retryAtMs: RESET_MS,
      reason: "credits-exhausted",
    });
    expect(
      parseCooldown({
        status: 403,
        body: { error: { code: "credits_exhausted" } },
      }),
    ).toEqual({
      retryAtMs: null,
      reason: "credits-exhausted",
    });
    expect(
      parseCooldown({
        status: 400,
        body: { code: "quota_exceeded" },
      }),
    ).toEqual({
      retryAtMs: null,
      reason: "credits-exhausted",
    });
  });

  it("Given status 500 or an unrelated body, When parseCooldown runs, Then it returns null", () => {
    expect(parseCooldown({ status: 500, body: { error: { message: "boom" } } })).toBeNull();
    expect(parseCooldown({ status: 200, body: { ok: true } })).toBeNull();
    expect(parseCooldown({ status: 404, body: { error: { code: "not_found" } } })).toBeNull();
  });

  it("Given an Anthropic-shaped rate_limit_error body, When parseCooldown runs, Then it is a rate-limit using message ISO or Retry-After", () => {
    const fromMessage = parseCooldown({
      status: 400,
      body: {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
        },
      },
    });
    const fromHeader = parseCooldown({
      status: 400,
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });

    expect(fromMessage).toEqual({
      retryAtMs: MESSAGE_ISO_MS,
      reason: "rate-limit",
    });
    expect(fromHeader).toEqual({
      retryAtMs: NOW_MS + 30_000,
      reason: "rate-limit",
    });
  });

  it("Given an OpenAI-shaped rate_limit_error body, When parseCooldown runs, Then it is a rate-limit using message ISO or Retry-After", () => {
    const fromMessage = parseCooldown({
      status: 400,
      body: {
        error: {
          code: "rate_limit_error",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
        },
      },
    });
    const fromHeader = parseCooldown({
      status: 400,
      body: { error: { code: "rate_limit_error" } },
      headers: { "Retry-After": HTTP_DATE },
    });

    expect(fromMessage).toEqual({
      retryAtMs: MESSAGE_ISO_MS,
      reason: "rate-limit",
    });
    expect(fromHeader).toEqual({
      retryAtMs: HTTP_DATE_MS,
      reason: "rate-limit",
    });
  });

  it("Given rateLimit.reset of 1e308, When parseCooldown runs, Then the invalid reset falls through to Retry-After or null", () => {
    const withRetryAfter = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { window: "fiveHour", reset: 1e308 },
        },
      },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });
    const withMessage = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
          rateLimit: { reset: 1e308 },
        },
      },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });
    const withoutHints = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { window: "daily", reset: 1e308 },
        },
      },
    });

    expect(withRetryAfter).toEqual({
      retryAtMs: NOW_MS + 30_000,
      reason: "rate-limit",
      window: "fiveHour",
    });
    expect(withMessage).toEqual({
      retryAtMs: MESSAGE_ISO_MS,
      reason: "rate-limit",
    });
    expect(withoutHints).toEqual({
      retryAtMs: null,
      reason: "rate-limit",
      window: "daily",
    });
  });

  it("Given rateLimit.reset exactly at the max valid Date epoch, When parseCooldown runs, Then retryAtMs is accepted", () => {
    const decision = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { window: "weekly", reset: MAX_DATE_SECONDS },
        },
      },
    });

    expect(decision).toEqual({
      retryAtMs: MAX_DATE_MS,
      reason: "rate-limit",
      window: "weekly",
    });
  });

  it("Given a Retry-After HTTP-date beyond the max valid Date, When parseCooldown runs, Then retryAtMs is null", () => {
    const decision = parseCooldown({
      status: 429,
      body: {},
      headers: { "Retry-After": FAR_FUTURE_HTTP_DATE },
    });

    expect(decision).toEqual({
      retryAtMs: null,
      reason: "rate-limit",
    });
  });

  it('Given rateLimit.reset as the string "1758000000", When parseCooldown runs, Then the string is ignored and the fallback chain is used', () => {
    const withMessage = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
          rateLimit: { reset: "1758000000" },
        },
      },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });
    const withRetryAfter = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { reset: "1758000000" },
        },
      },
      headers: { "retry-after": "30" },
      now: NOW_MS,
    });
    const withoutHints = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { reset: "1758000000" },
        },
      },
    });

    expect(withMessage).toEqual({
      retryAtMs: MESSAGE_ISO_MS,
      reason: "rate-limit",
    });
    expect(withRetryAfter).toEqual({
      retryAtMs: NOW_MS + 30_000,
      reason: "rate-limit",
    });
    expect(withoutHints).toEqual({
      retryAtMs: null,
      reason: "rate-limit",
    });
  });

  it("Given overflow, NaN, or Infinity on any conversion path, When parseCooldown runs, Then retryAtMs is never NaN or Infinity", () => {
    const decisions = [
      parseCooldown({
        status: 429,
        body: { error: { code: "RATE_LIMITED", rateLimit: { reset: 1e308 } } },
      }),
      parseCooldown({
        status: 429,
        body: { error: { code: "RATE_LIMITED", rateLimit: { reset: -1e308 } } },
      }),
      parseCooldown({
        status: 429,
        body: { error: { code: "RATE_LIMITED", rateLimit: { reset: Number.POSITIVE_INFINITY } } },
      }),
      parseCooldown({
        status: 429,
        body: { error: { code: "RATE_LIMITED", rateLimit: { reset: Number.NaN } } },
      }),
      parseCooldown({
        status: 429,
        body: {},
        headers: { "retry-after": OVERFLOW_RETRY_AFTER },
        now: NOW_MS,
      }),
      parseCooldown({
        status: 429,
        body: {},
        headers: { "Retry-After": FAR_FUTURE_HTTP_DATE },
      }),
      parseCooldown({
        status: 402,
        body: { error: { code: "insufficient_credits", rateLimit: { reset: 1e308 } } },
      }),
    ];

    for (const decision of decisions) {
      expect(decision).not.toBeNull();
      if (decision === null) continue;
      const retryAtMs = decision.retryAtMs;
      expect(retryAtMs === null || Number.isFinite(retryAtMs)).toBe(true);
      expect(retryAtMs).not.toBe(Number.POSITIVE_INFINITY);
      expect(retryAtMs).not.toBe(Number.NEGATIVE_INFINITY);
      if (retryAtMs !== null) {
        expect(Number.isNaN(retryAtMs)).toBe(false);
        expect(Math.abs(retryAtMs)).toBeLessThanOrEqual(MAX_DATE_MS);
      }
    }
  });

  it("Given rateLimit.reset of -1 and Retry-After 3600, When parseCooldown runs, Then the negative reset is skipped and retryAtMs is now plus 3600000", () => {
    const decision = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { reset: -1 },
        },
      },
      headers: { "retry-after": "3600" },
      now: NOW_MS,
    });

    expect(decision).toEqual({
      retryAtMs: NOW_MS + 3_600_000,
      reason: "rate-limit",
    });
  });

  it("Given rateLimit.reset 1700000060.1234, When parseCooldown runs, Then retryAtMs is the floored integer millisecond instant", () => {
    const decision = parseCooldown({
      status: 429,
      body: {
        error: {
          code: "RATE_LIMITED",
          rateLimit: { reset: FRACTIONAL_RESET_SECONDS },
        },
      },
    });

    expect(decision).toEqual({
      retryAtMs: FRACTIONAL_RESET_MS,
      reason: "rate-limit",
    });
    expect(Number.isInteger(FRACTIONAL_RESET_MS)).toBe(true);
  });

  it("Given a 429 with Retry-After delay-seconds 0.5, When parseCooldown runs, Then retryAtMs is now plus 500 (fractional seconds floor to integer ms)", () => {
    const decision = parseCooldown({
      status: 429,
      body: {},
      headers: { "retry-after": "0.5" },
      now: NOW_MS,
    });

    expect(decision).toEqual({
      retryAtMs: NOW_MS + 500,
      reason: "rate-limit",
    });
  });

  it("Given a 429 whose message carries a fractional retry-after-ms adapter marker, When parseCooldown runs, Then retryAtMs is now plus the delay floored to integer milliseconds", () => {
    const decision = parseCooldown({
      status: 429,
      body: { error: { message: "429 slow down (retry-after-ms: 1500.9)" } },
      now: NOW_MS,
    });

    expect(decision).toEqual({
      retryAtMs: NOW_MS + 1500,
      reason: "rate-limit",
    });
  });

  it("Given adversarial cooldown hints, When parseCooldown emits a retryAtMs, Then every value is an integer in [0, 8.64e15]", () => {
    const inputs: readonly ParseCooldownInput[] = [
      {
        status: 429,
        body: { error: { rateLimit: { reset: -1 } } },
        headers: { "retry-after": "3600" },
        now: NOW_MS,
      },
      {
        status: 429,
        body: { error: { rateLimit: { reset: FRACTIONAL_RESET_SECONDS } } },
      },
      { status: 429, body: {}, headers: { "retry-after": "0.5" }, now: NOW_MS },
      {
        status: 429,
        body: { error: { message: "429 slow down (retry-after-ms: 1500.9)" } },
        now: NOW_MS,
      },
      { status: 429, body: { error: { rateLimit: { reset: 0 } } } },
      { status: 429, body: {}, headers: { "retry-after": "0" }, now: NOW_MS },
      {
        status: 429,
        body: { error: { message: "429 slow down (retry-after-ms: 0)" } },
        now: NOW_MS,
      },
      {
        status: 429,
        body: { error: { message: "429 slow down (retry-after-ms: 0.9)" } },
        now: NOW_MS,
      },
      { status: 429, body: { error: { rateLimit: { reset: -0.1 } } }, headers: { "retry-after": "1" }, now: NOW_MS },
      { status: 429, body: { error: { rateLimit: { reset: 1.9 } } } },
      { status: 429, body: { error: { rateLimit: { reset: 1e308 } } } },
      { status: 429, body: { error: { rateLimit: { reset: -1e308 } } } },
      {
        status: 429,
        body: { error: { rateLimit: { reset: Number.POSITIVE_INFINITY } } },
      },
      {
        status: 429,
        body: { error: { rateLimit: { reset: Number.NEGATIVE_INFINITY } } },
      },
      { status: 429, body: { error: { rateLimit: { reset: Number.NaN } } } },
      { status: 429, body: { error: { rateLimit: { reset: Number.MAX_VALUE } } } },
      { status: 429, body: { error: { rateLimit: { reset: MAX_DATE_SECONDS } } } },
      {
        status: 429,
        body: { error: { rateLimit: { reset: MAX_DATE_SECONDS + 1 } } },
      },
      { status: 429, body: {}, headers: { "retry-after": OVERFLOW_RETRY_AFTER }, now: NOW_MS },
      { status: 429, body: {}, headers: { "Retry-After": FAR_FUTURE_HTTP_DATE } },
      { status: 429, body: {}, headers: { "retry-after": "1.9" }, now: NOW_MS },
      { status: 429, body: {}, headers: { "retry-after": "-1" }, now: NOW_MS },
      {
        status: 429,
        body: {
          error: {
            code: "RATE_LIMITED",
            message: `usage limit for your plan ... resets at ${MESSAGE_ISO}`,
            rateLimit: { reset: -1 },
          },
        },
        headers: { "retry-after": "3600" },
        now: NOW_MS,
      },
      {
        status: 429,
        body: {
          error: {
            message: "429 slow down (retry-after-ms: 1500.9)",
            rateLimit: { reset: -1 },
          },
        },
        headers: { "retry-after": "3600" },
        now: NOW_MS,
      },
      { status: 402, body: { error: { rateLimit: { reset: -1 } } } },
      {
        status: 402,
        body: { error: { rateLimit: { reset: FRACTIONAL_RESET_SECONDS } } },
      },
      {
        status: 429,
        body: {
          error: {
            code: "RATE_LIMITED",
            rateLimit: { window: "daily", reset: -5 },
          },
        },
      },
      {
        status: 429,
        body: { error: { message: `usage limit for your plan ... resets at ${MESSAGE_ISO}` } },
      },
    ];

    for (const input of inputs) {
      const decision = parseCooldown(input);
      if (decision === null) continue;
      const retryAtMs = decision.retryAtMs;
      if (retryAtMs === null) continue;
      expect(Number.isInteger(retryAtMs)).toBe(true);
      expect(retryAtMs).toBeGreaterThanOrEqual(0);
      expect(retryAtMs).toBeLessThanOrEqual(MAX_DATE_MS);
    }
  });
});
