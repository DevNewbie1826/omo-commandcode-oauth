import { describe, expect, it } from "vitest";
import { parseCooldown } from "../extensions/commandcode/ratelimit.js";

const RESET_SECONDS = 1_758_000_000;
const RESET_MS = RESET_SECONDS * 1000;
const MESSAGE_ISO = "2026-09-12T05:00:00Z";
const MESSAGE_ISO_MS = Date.parse(MESSAGE_ISO);
const HTTP_DATE = "Wed, 16 Sep 2026 05:00:00 GMT";
const HTTP_DATE_MS = Date.parse(HTTP_DATE);
const NOW_MS = 1_700_000_000_000;

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
});
