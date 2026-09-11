import { describe, expect, it } from "vitest";
import { classifyFailure } from "../extensions/commandcode/ratelimit.js";

describe("failure classifier", () => {
  it.each([429, 500, 502, 503, 599])("classifies HTTP %s as rotatable", (status) => {
    expect(classifyFailure({ status })).toBe("rotatable");
  });

  it.each([
    { error: { code: "RATE_LIMITED" } },
    { error: { type: "rate_limit_error" } },
    { code: "rate_limit_error" },
    JSON.stringify({ error: { code: "RATE_LIMITED" } }),
  ])("classifies rate-limit body shape %# as rotatable", (body) => {
    expect(classifyFailure({ status: 400, body })).toBe("rotatable");
  });

  it("classifies adapter-folded rate-limit messages as rotatable", () => {
    expect(classifyFailure({ message: "429 rate_limit_error" })).toBe("rotatable");
    expect(classifyFailure({ message: "RATE_LIMITED" })).toBe("rotatable");
  });

  it("classifies network failures as rotatable", () => {
    expect(classifyFailure({ network: true, message: "socket closed" })).toBe("rotatable");
  });

  it.each([401, 403])("classifies auth HTTP %s as propagate even with a rate-limit body", (status) => {
    expect(classifyFailure({ status, body: { error: { code: "RATE_LIMITED" } }, network: true }))
      .toBe("propagate");
  });

  it.each([400, 402, 404])("classifies unrelated HTTP %s as propagate", (status) => {
    expect(classifyFailure({ status, body: { error: { code: "bad_request" } } }))
      .toBe("propagate");
  });
});
