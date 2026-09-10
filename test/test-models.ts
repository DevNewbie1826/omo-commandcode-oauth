import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  ModelsParseError,
  STATIC_MODELS,
  isReasoningModel,
  loadModels,
  modelsFromApiResponse,
  modelsFromCache,
  type CommandCodeModel,
  type FetchImpl,
} from "../extensions/commandcode/models.js";

const API_RESPONSE = {
  object: "list",
  data: [
    {
      id: "Qwen/Qwen3.7-Max",
      name: "Qwen 3.7 Max",
      context_length: 1_000_000,
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      context_length: 200_000.4,
    },
  ],
} as const;

const EXPECTED_FROM_API: readonly CommandCodeModel[] = [
  {
    id: "Qwen/Qwen3.7-Max",
    name: "Qwen 3.7 Max",
    reasoning: false,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
];

const T0 = 1_700_000_000_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch(body: unknown = API_RESPONSE): FetchImpl {
  return () => Promise.resolve(jsonResponse(body));
}

function failingFetch(message = "offline"): FetchImpl {
  return () => Promise.reject(new TypeError(message));
}

async function withTemporaryCache(
  run: (paths: { readonly directory: string; readonly cachePath: string }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "commandcode-models-"));
  try {
    await run({ directory, cachePath: join(directory, "omo-models.json") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const originalCacheEnv = process.env.COMMANDCODE_MODELS_CACHE;

afterEach(() => {
  if (originalCacheEnv === undefined) {
    delete process.env.COMMANDCODE_MODELS_CACHE;
  } else {
    process.env.COMMANDCODE_MODELS_CACHE = originalCacheEnv;
  }
});

describe("modelsFromApiResponse", () => {
  it("Given an OpenAI-style list envelope, When parsed, Then ids names and reasoning map with capped maxTokens", () => {
    expect(modelsFromApiResponse(API_RESPONSE)).toEqual(EXPECTED_FROM_API);
  });

  it("Given a response whose object is not list, When parsed, Then it throws ModelsParseError", () => {
    expect(() => modelsFromApiResponse({ object: "model", data: [] })).toThrow(ModelsParseError);
    expect(() => modelsFromApiResponse({ data: [] })).toThrow(/object to be 'list'/);
  });

  it("Given a fractional context_length, When parsed, Then contextWindow is a rounded integer", () => {
    const models = modelsFromApiResponse({
      object: "list",
      data: [{ id: "gpt-5.5", name: "GPT-5.5", context_length: 128_000.6 }],
    });
    expect(models).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        contextWindow: 128_001,
        maxTokens: 65_536,
      },
    ]);
  });

  it("Given an empty data array, When parsed, Then it throws an empty-catalog error", () => {
    expect(() => modelsFromApiResponse({ object: "list", data: [] })).toThrow(/empty model catalog/);
  });
});

describe("isReasoningModel", () => {
  it("Given model ids, When classified, Then the marker heuristic is deterministic", () => {
    const cases = [
      ["gpt-5.5", true],
      ["o3-mini", true],
      ["claude-sonnet-4-6", true],
      ["zai-org/GLM-5.1", true],
      ["deepseek-reasoner", true],
      ["Qwen/QwQ-32B", true],
      ["foo-think-bar", true],
      ["Qwen/Qwen3.7-Max", false],
      ["deepseek/deepseek-v4-flash", false],
    ] as const;

    for (const [id, expected] of cases) {
      expect(isReasoningModel(id)).toBe(expected);
    }
  });
});

describe("modelsFromCache", () => {
  it("Given a version-1 cache document, When parsed, Then models round-trip", () => {
    expect(
      modelsFromCache({
        version: 1,
        fetchedAt: T0,
        models: EXPECTED_FROM_API,
      }),
    ).toEqual(EXPECTED_FROM_API);
  });

  it("Given empty invalid or oversized cache entries, When parsed, Then it throws ModelsParseError", () => {
    const sample: CommandCodeModel = {
      id: "Qwen/Qwen3.7-Max",
      name: "Qwen 3.7 Max",
      reasoning: false,
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    };
    expect(() => modelsFromCache({ version: 1, fetchedAt: T0, models: [] })).toThrow(ModelsParseError);
    expect(() =>
      modelsFromCache({ version: 2, fetchedAt: T0, models: EXPECTED_FROM_API }),
    ).toThrow(/version 1/);
    expect(() =>
      modelsFromCache({
        version: 1,
        fetchedAt: T0,
        models: [{ ...sample, contextWindow: -1 }],
      }),
    ).toThrow(ModelsParseError);
    expect(() =>
      modelsFromCache({
        version: 1,
        fetchedAt: T0,
        models: [{ ...sample, maxTokens: 2_000_000, contextWindow: 1_000_000 }],
      }),
    ).toThrow(ModelsParseError);
  });
});

describe("loadModels", () => {
  it("Given a live list response, When loaded, Then source is live and the cache file round-trips via COMMANDCODE_MODELS_CACHE", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      process.env.COMMANDCODE_MODELS_CACHE = cachePath;

      const result = await loadModels({
        fetchImpl: successfulFetch(),
        now: () => T0,
      });

      expect(result).toEqual({ models: EXPECTED_FROM_API, source: "live" });

      const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
      expect(parsed).toEqual({
        version: 1,
        fetchedAt: T0,
        models: EXPECTED_FROM_API,
      });
      expect(modelsFromCache(parsed)).toEqual(EXPECTED_FROM_API);
    });
  });

  it("Given an empty live catalog, When loaded without a cache, Then it falls back to static", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadModels({
        cachePath,
        fetchImpl: successfulFetch({ object: "list", data: [] }),
        now: () => T0,
      });

      expect(result.source).toBe("static");
      expect(result.models).toEqual(STATIC_MODELS);
      expect(result.warning).toMatch(/empty model catalog/i);
    });
  });

  it("Given a stale cache and a failed fetch, When loaded, Then the cache is still served", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadModels({
        cachePath,
        fetchImpl: successfulFetch(),
        now: () => T0,
      });

      let fetchCalls = 0;
      const fetchImpl: FetchImpl = () => {
        fetchCalls += 1;
        return Promise.reject(new TypeError("offline"));
      };

      const result = await loadModels({
        cachePath,
        fetchImpl,
        now: () => T0 + CACHE_TTL_MS + 1,
      });

      expect(fetchCalls).toBe(1);
      expect(result.models).toEqual(EXPECTED_FROM_API);
      expect(result.source).toBe("cache");
      expect(result.warning).toMatch(/offline/);
    });
  });

  it("Given a fresh-enough cache, When loaded, Then fetchImpl is not called", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      await loadModels({
        cachePath,
        fetchImpl: successfulFetch(),
        now: () => T0,
      });

      let fetchCalls = 0;
      const fetchImpl: FetchImpl = () => {
        fetchCalls += 1;
        return Promise.reject(new TypeError("should not fetch"));
      };

      const result = await loadModels({
        cachePath,
        fetchImpl,
        now: () => T0 + CACHE_TTL_MS - 1,
      });

      expect(fetchCalls).toBe(0);
      expect(result).toEqual({ models: EXPECTED_FROM_API, source: "cache" });
    });
  });

  it("Given no cache and a failed fetch, When loaded, Then the static fallback is served", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadModels({
        cachePath,
        fetchImpl: failingFetch(),
        now: () => T0,
      });

      expect(result.source).toBe("static");
      expect(result.models).toEqual(STATIC_MODELS);
      expect(result.warning).toMatch(/offline/);
      expect(STATIC_MODELS.map((model) => model.id)).toEqual([
        "claude-sonnet-4-6",
        "gpt-5.5",
        "deepseek/deepseek-v4-flash",
        "zai-org/GLM-5.1",
      ]);
      for (const model of STATIC_MODELS) {
        expect(model.contextWindow).toBe(200_000);
        expect(model.maxTokens).toBe(65_536);
      }
    });
  });

  it("Given a 401 from the public endpoint and no cache, When loaded, Then it falls back to static", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const result = await loadModels({
        cachePath,
        fetchImpl: () => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)),
        now: () => T0,
      });

      expect(result.source).toBe("static");
      expect(result.models).toEqual(STATIC_MODELS);
      expect(result.warning).toMatch(/401/);
    });
  });

  it("Given a pre-written cache file, When modelsFromCache reads it, Then the round-trip matches", async () => {
    await withTemporaryCache(async ({ cachePath }) => {
      const document = { version: 1, fetchedAt: T0, models: EXPECTED_FROM_API };
      await writeFile(cachePath, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
      const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
      expect(modelsFromCache(parsed)).toEqual(EXPECTED_FROM_API);
    });
  });
});
