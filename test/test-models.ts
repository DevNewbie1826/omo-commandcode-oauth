import { describe, expect, it } from "vitest";
import {
  ModelsParseError,
  STATIC_MODELS,
  isReasoningModel,
  loadModels,
  modelsFromApiResponse,
  type CommandCodeModel,
  type FetchImpl,
} from "../extensions/commandcode/models.js";

const API_RESPONSE = {
  object: "list",
  data: [
    { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", context_length: 1_000_000 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 200_000.4 },
  ],
} as const;
const EXPECTED: readonly CommandCodeModel[] = [
  { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", api: "openai-completions", reasoning: false, contextWindow: 1_000_000, maxTokens: 65_536 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", api: "anthropic-messages", reasoning: true, contextWindow: 200_000, maxTokens: 65_536 },
];
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function successfulFetch(body: unknown = API_RESPONSE): FetchImpl {
  return () => Promise.resolve(response(body));
}

describe("modelsFromApiResponse", () => {
  it("maps ids, names, routes, reasoning, rounded context, and capped output", () => {
    expect(modelsFromApiResponse(API_RESPONSE)).toEqual(EXPECTED);
  });

  it("rejects malformed and empty list envelopes", () => {
    expect(() => modelsFromApiResponse({ object: "model", data: [] })).toThrow(ModelsParseError);
    expect(() => modelsFromApiResponse({ data: [] })).toThrow(/object to be 'list'/);
    expect(() => modelsFromApiResponse({ object: "list", data: [] })).toThrow(/empty model catalog/);
  });

  it("rounds a fractional context length", () => {
    expect(modelsFromApiResponse({
      object: "list",
      data: [{ id: "gpt-5.5", name: "GPT-5.5", context_length: 128_000.6 }],
    })[0]).toMatchObject({ api: "openai-completions", contextWindow: 128_001, maxTokens: 65_536 });
  });
});

describe("isReasoningModel", () => {
  it("applies the model-id marker heuristic", () => {
    const cases = [
      ["gpt-5.5", true], ["o3-mini", true], ["claude-sonnet-4-6", true],
      ["zai-org/GLM-5.1", true], ["deepseek-reasoner", true], ["Qwen/QwQ-32B", true],
      ["foo-think-bar", true], ["Qwen/Qwen3.7-Max", false], ["deepseek/deepseek-v4-flash", false],
    ] as const;
    for (const [id, expected] of cases) expect(isReasoningModel(id)).toBe(expected);
  });
});

describe("loadModels", () => {
  it("loads the live catalog into process memory", async () => {
    await expect(loadModels({ fetchImpl: successfulFetch() }))
      .resolves.toEqual({ models: EXPECTED, source: "live" });
  });

  it("uses the static catalog when the live response is invalid", async () => {
    const result = await loadModels({ fetchImpl: successfulFetch({ object: "list", data: [] }) });
    expect(result).toMatchObject({ models: STATIC_MODELS, source: "static" });
    expect(result.warning).toMatch(/empty model catalog/i);
  });

  it("uses the static catalog when the request fails", async () => {
    const result = await loadModels({ fetchImpl: () => Promise.reject(new TypeError("offline")) });
    expect(result).toMatchObject({ models: STATIC_MODELS, source: "static" });
    expect(result.warning).toMatch(/offline/);
    expect(STATIC_MODELS.map((model) => model.id)).toEqual([
      "claude-sonnet-4-6", "gpt-5.5", "deepseek/deepseek-v4-flash", "zai-org/GLM-5.1",
    ]);
  });

  it("uses the static catalog for a non-success response", async () => {
    const result = await loadModels({ fetchImpl: () => Promise.resolve(response({ error: "no" }, 401)) });
    expect(result).toMatchObject({ models: STATIC_MODELS, source: "static" });
    expect(result.warning).toMatch(/401/);
  });
});
