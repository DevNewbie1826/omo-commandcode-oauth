export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
const MAX_TOKENS = 65_536;
const MAX_CONTEXT = 10_000_000;
const REASONING_MARKERS = ["gpt", "o3", "claude", "glm", "deepseek-reasoner", "qwq", "think"] as const;

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type CommandCodeApi = "anthropic-messages" | "openai-completions";

export interface CommandCodeModel {
  readonly id: string;
  readonly name: string;
  readonly api: CommandCodeApi;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface LoadModelsResult {
  readonly models: readonly CommandCodeModel[];
  readonly source: "live" | "static";
  readonly warning?: string;
}

export interface LoadModelsOptions {
  readonly url?: string;
  readonly apiKey?: string;
  readonly fetchImpl?: FetchImpl;
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

export function apiForModel(id: string): CommandCodeApi {
  return id.toLowerCase().startsWith("claude") ? "anthropic-messages" : "openai-completions";
}

function catalogModel(id: string, name: string, contextWindow: number): CommandCodeModel {
  return {
    id,
    name,
    api: apiForModel(id),
    reasoning: isReasoningModel(id),
    contextWindow,
    maxTokens: Math.min(contextWindow, MAX_TOKENS),
  };
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

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ModelsParseError(`Expected ${key} to be a finite number`);
  }
  return value;
}

function parseApiModel(value: unknown): CommandCodeModel {
  if (!isRecord(value)) throw new ModelsParseError("Expected model entry to be an object");
  const contextWindow = Math.round(numberField(value, "context_length"));
  if (contextWindow < 1 || contextWindow > MAX_CONTEXT) {
    throw new ModelsParseError("Expected context_length to round to a positive integer within bounds");
  }
  return catalogModel(stringField(value, "id"), stringField(value, "name"), contextWindow);
}

export function modelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new ModelsParseError("Expected models response to be an object");
  if (value.object !== "list") throw new ModelsParseError("Expected models response object to be 'list'");
  if (!Array.isArray(value.data)) throw new ModelsParseError("Expected models response data to be an array");
  const models = value.data.map(parseApiModel);
  if (models.length === 0) throw new ModelsParseError("Command Code returned an empty model catalog");
  return models;
}

function resolveUrl(url?: string): string {
  if (url) return url;
  const override = process.env.COMMANDCODE_API_BASE;
  return override ? `${override.replace(/\/+$/, "")}/provider/v1/models` : DEFAULT_MODELS_URL;
}

async function fetchLiveModels(options: LoadModelsOptions): Promise<readonly CommandCodeModel[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const response = await (options.fetchImpl ?? fetch)(resolveUrl(options.url), { headers });
  if (!response.ok) {
    throw new ModelsFetchError(`Failed to fetch Command Code models: ${response.status} ${response.statusText}`);
  }
  return modelsFromApiResponse(await response.json() as unknown);
}

export async function loadModels(options: LoadModelsOptions = {}): Promise<LoadModelsResult> {
  try {
    return { models: await fetchLiveModels(options), source: "live" };
  } catch (error) {
    return {
      models: STATIC_MODELS,
      source: "static",
      warning: `Could not refresh the Command Code model catalog (${errorMessage(error)}). Using the static catalog.`,
    };
  }
}
