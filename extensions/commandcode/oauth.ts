import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import {
  closeServer,
  CommandCodeAuthError,
  startAuthServer,
  type AuthCallbackPayload,
} from "./auth-server.js";

export const DEFAULT_API_BASE = "https://api.commandcode.ai";
export const DEFAULT_STUDIO_BASE = "https://commandcode.ai";
export const DEFAULT_AUTH_TIMEOUT_MS = 120_000;
export const API_KEY_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const BRACKETED_PASTE_MARKERS = /(?:\x1b)?\[(?:200|201)~/g;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;
const PASTE_PROMPT = "Browser login did not complete in time. Paste your Command Code API key.";
const LOGIN_INSTRUCTIONS = "Complete the Command Code login in your browser. The API key is delivered to the local callback server.";

export class CommandCodeInvalidKeyError extends CommandCodeAuthError {
  readonly retryable = false as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeInvalidKeyError";
  }
}

export class CommandCodeKeyValidationError extends CommandCodeAuthError {
  readonly retryable = true as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeKeyValidationError";
  }
}

export class CommandCodeLoginError extends CommandCodeAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeLoginError";
  }
}

class CommandCodeLoginTimeoutError extends CommandCodeLoginError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeLoginTimeoutError";
  }
}

export type WhoamiInfo = {
  readonly userId: string;
  readonly userName: string;
};

export type ValidateApiKey = (apiKey: string) => Promise<WhoamiInfo>;

export type CreateLoginOptions = {
  readonly validate?: ValidateApiKey;
  readonly fetchFn?: typeof fetch;
  /** Persisted-credential hook; awaited by the login flow, so a rejection fails the login. */
  readonly onCredential?: (apiKey: string) => void | Promise<void>;
  readonly apiBase?: string;
  readonly studioBase?: string;
  readonly authTimeoutMs?: number;
  readonly now?: () => number;
};

export type CommandCodeLogin = (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;

type ResolvedLoginOptions = {
  readonly studioBase: string;
  readonly authTimeoutMs: number;
  readonly now: () => number;
  readonly validate: ValidateApiKey;
  readonly onCredential: ((apiKey: string) => void | Promise<void>) | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandCodeKeyValidationError(`Expected whoami ${key} to be a non-empty string`);
  }
  return value;
}

function parseWhoamiPayload(payload: unknown): WhoamiInfo {
  if (!isRecord(payload)) {
    throw new CommandCodeKeyValidationError("Command Code whoami response was not an object");
  }
  const user = isRecord(payload.user) ? payload.user : payload;
  return {
    userId: nonEmptyStringField(user, "id"),
    userName: nonEmptyStringField(user, "userName"),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function authTimeoutFromEnv(): number {
  const raw = process.env.COMMANDCODE_AUTH_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AUTH_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AUTH_TIMEOUT_MS;
  return parsed;
}

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildAuthUrl(studioBase: string, port: number, state: string): string {
  const callback = `http://127.0.0.1:${port}/callback`;
  return `${studioBase}/studio/auth/cli?callback=${encodeURIComponent(callback)}&state=${state}&mode=redirect`;
}

async function validateApiKeyWithWhoami(
  apiKey: string,
  apiBase: string,
  fetchFn: typeof fetch,
): Promise<WhoamiInfo> {
  let response: Response;
  try {
    response = await fetchFn(`${apiBase}/alpha/whoami`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (cause) {
    throw new CommandCodeKeyValidationError(`Command Code whoami request failed (${messageOf(cause)})`, {
      cause,
    });
  }
  if (response.status === 401) {
    throw new CommandCodeInvalidKeyError("Command Code rejected the API key (whoami returned 401)");
  }
  if (!response.ok) {
    throw new CommandCodeKeyValidationError(`Command Code whoami request failed with status ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new CommandCodeKeyValidationError("Command Code whoami response was not valid JSON", { cause });
  }
  return parseWhoamiPayload(payload);
}

async function obtainApiKey(
  callbacks: OAuthLoginCallbacks,
  waitForCallback: Promise<AuthCallbackPayload>,
  server: Server,
  timeoutMs: number,
): Promise<string> {
  const racers: Array<Promise<AuthCallbackPayload>> = [waitForCallback];
  const signal = callbacks.signal;
  if (signal !== undefined) {
    racers.push(
      new Promise<AuthCallbackPayload>((_, reject) => {
        const onAbort = (): void => {
          reject(new CommandCodeLoginError("Command Code login was cancelled"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  racers.push(
    new Promise<AuthCallbackPayload>((_, reject) => {
      timer = setTimeout(() => {
        reject(new CommandCodeLoginTimeoutError(`Command Code browser login timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  );
  try {
    const payload = await Promise.race(racers);
    return payload.apiKey;
  } catch (error) {
    await closeServer(server);
    if (error instanceof CommandCodeLoginTimeoutError) {
      const pasted = sanitizeApiKey(await callbacks.onPrompt({ message: PASTE_PROMPT }));
      if (pasted.length === 0) throw new CommandCodeLoginError("No Command Code API key was pasted");
      return pasted;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function loginInBrowser(
  callbacks: OAuthLoginCallbacks,
  options: ResolvedLoginOptions,
): Promise<OAuthCredentials> {
  const expectedState = generateStateToken();
  const { server, port, waitForCallback } = await startAuthServer({ expectedState });
  callbacks.onAuth({ url: buildAuthUrl(options.studioBase, port, expectedState), instructions: LOGIN_INSTRUCTIONS });
  callbacks.onProgress?.("Waiting for Command Code authentication in your browser...");
  const apiKey = await obtainApiKey(callbacks, waitForCallback, server, options.authTimeoutMs);
  await options.validate(apiKey);
  const credentials = credentialsFromApiKey(apiKey, options.now);
  await options.onCredential?.(apiKey);
  return credentials;
}

export function sanitizeApiKey(input: string): string {
  return input.replace(BRACKETED_PASTE_MARKERS, "").replace(CONTROL_CHARACTERS, "").trim();
}

export function generateStateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function credentialsFromApiKey(apiKey: string, now: () => number = Date.now): OAuthCredentials {
  if (apiKey.length === 0) throw new CommandCodeLoginError("Command Code API key must be a non-empty string");
  return { access: apiKey, refresh: apiKey, expires: now() + API_KEY_TTL_MS };
}

export async function refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return credentials;
}

export function getApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

export function createLogin(options: CreateLoginOptions = {}): CommandCodeLogin {
  return (callbacks) => {
    const fetchFn = options.fetchFn ?? fetch;
    const apiBase = normalizeBase(options.apiBase ?? process.env.COMMANDCODE_API_BASE ?? DEFAULT_API_BASE);
    const studioBase = normalizeBase(options.studioBase ?? DEFAULT_STUDIO_BASE);
    const authTimeoutMs = options.authTimeoutMs ?? authTimeoutFromEnv();
    const now = options.now ?? Date.now;
    const validate = options.validate ?? ((apiKey: string) => validateApiKeyWithWhoami(apiKey, apiBase, fetchFn));
    return loginInBrowser(callbacks, {
      studioBase,
      authTimeoutMs,
      now,
      validate,
      onCredential: options.onCredential,
    });
  };
}
