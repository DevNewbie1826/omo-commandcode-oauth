import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;
const MAX_TOKENS = 65_536;
const MAX_CONTEXT = 10_000_000;
const REASONING_MARKERS = ["gpt", "o3", "claude", "glm", "deepseek-reasoner", "qwq", "think"] as const;

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CommandCodeModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface LoadModelsResult {
  readonly models: readonly CommandCodeModel[];
  readonly source: "live" | "cache" | "static";
  readonly warning?: string;
}

export interface LoadModelsOptions {
  readonly url?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: FetchImpl;
  readonly cachePath?: string;
  readonly now?: () => number;
}

interface CacheDocument {
  readonly fetchedAt: number;
  readonly models: readonly CommandCodeModel[];
}

export class ModelsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsParseError";
  }
}

export class ModelsFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsFetchError";
  }
}

export function isReasoningModel(id: string): boolean {
  const haystack = id.toLowerCase();
  return REASONING_MARKERS.some((marker) => haystack.includes(marker));
}

function catalogModel(id: string, name: string, contextWindow: number): CommandCodeModel {
  return { id, name, reasoning: isReasoningModel(id), contextWindow, maxTokens: Math.min(contextWindow, MAX_TOKENS) };
}

export const STATIC_MODELS: readonly CommandCodeModel[] = [
  catalogModel("claude-sonnet-4-6", "claude-sonnet-4-6", 200_000),
  catalogModel("gpt-5.5", "gpt-5.5", 200_000),
  catalogModel("deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash", 200_000),
  catalogModel("zai-org/GLM-5.1", "zai-org/GLM-5.1", 200_000),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelsParseError(`Expected ${key} to be a non-empty string`);
  }
  return value;
}
function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new ModelsParseError(`Expected ${key} to be a boolean`);
  return value;
}
function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelsParseError(`Expected ${key} to be a finite number`);
  }
  return value;
}
function positiveIntField(record: Record<string, unknown>, key: string): number {
  const value = numberField(record, key);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ModelsParseError(`Expected ${key} to be a positive integer`);
  }
  return value;
}
function requireModels(models: readonly CommandCodeModel[]): readonly CommandCodeModel[] {
  if (models.length === 0) throw new ModelsParseError("Command Code returned an empty model catalog");
  return models;
}

function parseApiModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new ModelsParseError("Expected model entry to be an object");
  const contextWindow = Math.round(numberField(value, "context_length"));
  if (contextWindow < 1 || contextWindow > MAX_CONTEXT) {
    throw new ModelsParseError("Expected context_length to round to a positive integer within bounds");
  }
  return catalogModel(stringField(value, "id"), stringField(value, "name"), contextWindow);
}

function parseCachedModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new ModelsParseError("Expected cached model entry to be an object");
  const contextWindow = positiveIntField(value, "contextWindow");
  const maxTokens = positiveIntField(value, "maxTokens");
  if (maxTokens > contextWindow || contextWindow > MAX_CONTEXT || maxTokens > MAX_TOKENS) {
    throw new ModelsParseError("Cached model maxTokens must not exceed contextWindow");
  }
  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    reasoning: booleanField(value, "reasoning"),
    contextWindow,
    maxTokens,
  };
}

export function modelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new ModelsParseError("Expected models response to be an object");
  if (value.object !== "list") throw new ModelsParseError("Expected models response object to be 'list'");
  if (!Array.isArray(value.data)) throw new ModelsParseError("Expected models response data to be an array");
  const models: CommandCodeModel[] = [];
  for (const entry of value.data) models.push(parseApiModel(entry));
  return requireModels(models);
}

function parseCacheDocument(value: unknown): CacheDocument {
  if (!isRecord(value)) throw new ModelsParseError("Expected model cache to be an object");
  if (value.version !== CACHE_VERSION) {
    throw new ModelsParseError(`Expected model cache version ${CACHE_VERSION}`);
  }
  if (!Array.isArray(value.models)) throw new ModelsParseError("Expected cached models to be an array");
  const models: CommandCodeModel[] = [];
  for (const entry of value.models) models.push(parseCachedModel(entry));
  return { fetchedAt: numberField(value, "fetchedAt"), models: requireModels(models) };
}

export function modelsFromCache(value: unknown): readonly CommandCodeModel[] {
  return parseCacheDocument(value).models;
}

function resolveCachePath(cachePath?: string): string {
  if (cachePath !== undefined && cachePath.length > 0) return cachePath;
  const fromEnv = process.env.COMMANDCODE_MODELS_CACHE;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".commandcode", "omo-models.json");
}

function resolveUrl(url?: string): string {
  if (url !== undefined && url.length > 0) return url;
  const override = process.env.COMMANDCODE_API_BASE;
  if (override !== undefined && override.length > 0) {
    return `${override.replace(/\/+$/, "")}/provider/v1/models`;
  }
  return DEFAULT_MODELS_URL;
}

async function readCache(cachePath: string): Promise<CacheDocument> {
  const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
  return parseCacheDocument(parsed);
}

async function writeCache(cachePath: string, models: readonly CommandCodeModel[], fetchedAt: number): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify({ version: CACHE_VERSION, fetchedAt, models }, null, 2)}\n`, "utf-8");
}

async function fetchLiveModels(options: LoadModelsOptions): Promise<readonly CommandCodeModel[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey !== undefined && options.apiKey.length > 0) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(resolveUrl(options.url), { headers });
  if (!response.ok) {
    throw new ModelsFetchError(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  return modelsFromApiResponse(body);
}

export async function loadModels(options: LoadModelsOptions = {}): Promise<LoadModelsResult> {
  try {
    const cachePath = resolveCachePath(options.cachePath);
    const now = options.now ?? Date.now;
    let cached: CacheDocument | undefined;
    let cacheReadError: string | undefined;
    try {
      cached = await readCache(cachePath);
    } catch (error) {
      cacheReadError = errorMessage(error);
    }
    if (cached !== undefined && now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { models: cached.models, source: "cache" };
    }
    try {
      const models = await fetchLiveModels(options);
      try {
        await writeCache(cachePath, models, now());
        return { models, source: "live" };
      } catch (error) {
        return {
          models,
          source: "live",
          warning: `Loaded the live Command Code model catalog but could not update ${cachePath}: ${errorMessage(error)}`,
        };
      }
    } catch (liveError) {
      if (cached !== undefined) {
        return {
          models: cached.models,
          source: "cache",
          warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)}). Using the cached catalog from ${cachePath}.`,
        };
      }
      const cacheNote =
        cacheReadError === undefined
          ? ""
          : `, and no valid cached catalog is available at ${cachePath} (${cacheReadError})`;
      return {
        models: STATIC_MODELS,
        source: "static",
        warning: `Could not refresh the Command Code model catalog (${errorMessage(liveError)})${cacheNote}.`,
      };
    }
  } catch (error) {
    return { models: STATIC_MODELS, source: "static", warning: errorMessage(error) };
  }
}
