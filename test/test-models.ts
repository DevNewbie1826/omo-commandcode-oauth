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

/** The exact tier translation measured against the live gateway (see models.ts for the probe log). */
const MEASURED_THINKING_LEVEL_MAP = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

const API_RESPONSE = {
  object: "list",
  data: [
    { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max", context_length: 1_000_000 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 200_000.4 },
  ],
} as const;
const EXPECTED: readonly CommandCodeModel[] = [
  {
    id: "Qwen/Qwen3.7-Max",
    name: "Qwen 3.7 Max",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: { ...MEASURED_THINKING_LEVEL_MAP },
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
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

describe("thinkingLevelMap", () => {
  it("attaches the measured gateway map to openai-route catalog ids", () => {
    const models = modelsFromApiResponse({
      object: "list",
      data: [
        { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_length: 200_000 },
        { id: "zai-org/GLM-5.2", name: "GLM-5.2", context_length: 200_000 },
      ],
    });

    expect(models[0]?.thinkingLevelMap).toEqual({ ...MEASURED_THINKING_LEVEL_MAP });
    expect(models[1]?.thinkingLevelMap).toEqual({ ...MEASURED_THINKING_LEVEL_MAP });
    // The map must pin exactly the six host reasoning levels, translated onto the five values the
    // gateway accepts (it rejects "minimal"); "off" stays unmapped so the host keeps exposing it
    // and the adapter merely omits reasoning_effort.
    expect(Object.keys(models[0]?.thinkingLevelMap ?? {}).sort())
      .toEqual(["high", "low", "max", "medium", "minimal", "xhigh"]);
  });

  it("attaches no map to claude ids so native tier inference stays authoritative", () => {
    const models = modelsFromApiResponse({
      object: "list",
      data: [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 200_000 },
        { id: "claude-opus-5", name: "Claude Opus 5", context_length: 200_000 },
      ],
    });

    expect(models[0]?.thinkingLevelMap).toBeUndefined();
    expect(models[1]?.thinkingLevelMap).toBeUndefined();
    for (const model of STATIC_MODELS) {
      if (model.id.toLowerCase().startsWith("claude")) {
        expect(model.thinkingLevelMap).toBeUndefined();
      } else {
        expect(model.thinkingLevelMap).toEqual({ ...MEASURED_THINKING_LEVEL_MAP });
      }
    }
  });
});

describe("isReasoningModel", () => {
  it("advertises every served model as thinking-capable so the host can send a thinking level", () => {
    // Live probes accepted `reasoning_effort` on every Command Code family (deepseek, moonshot,
    // z-ai, qwen, minimax, xiaomi, stepfun, xai, meta, tencent, thinkingmachines); the previous
    // id-marker heuristic hid the thinking control for all of them.
    const ids = [
      "gpt-5.5", "claude-sonnet-4-6", "zai-org/GLM-5.1", "deepseek/deepseek-v4.1-flash",
      "moonshotai/Kimi-K2.6", "Qwen/Qwen3.7-Max", "google/gemini-3.5-flash", "xai/grok-4.5",
    ] as const;
    for (const id of ids) expect(isReasoningModel(id)).toBe(true);
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
