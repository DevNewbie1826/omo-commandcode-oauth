/**
 * Command Code (commandcode.ai) provider extension.
 *
 * Registers the "commandcode" provider on the anthropic-messages API with
 * browser OAuth login, a shared multi-account store, and a rate-limit
 * rotating failover transport. Every login credential is added to the
 * shared account pool (`COMMANDCODE_ACCOUNTS_FILE`), so independently
 * logged-in sessions rotate through one pool with per-account cooldowns.
 */
import { randomUUID } from "node:crypto";
import type { ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AccountPool } from "./accounts/pool.js";
import { AccountStoreError } from "./accounts/schema.js";
import { AccountStore, resolveAccountsFilePath } from "./accounts/store.js";
import { createBillingCache, fetchBillingSnapshot } from "./billing.js";
import { loadModels, type CommandCodeModel } from "./models.js";
import {
  CommandCodeInvalidKeyError,
  CommandCodeKeyValidationError,
  DEFAULT_API_BASE,
  createLogin,
  refreshToken,
  type CommandCodeLogin,
  type WhoamiInfo,
} from "./oauth.js";
import { parseCooldown } from "./ratelimit.js";
import { createFailoverStream, sessionIdFromContext, type StreamSimpleLike } from "./transport.js";

const PROVIDER_ID = "commandcode";
const PROVIDER_NAME = "Command Code (unofficial)";

/** Transport modules are optional at runtime: without them the provider registers without failover. */
let anthropicStreamSimple: StreamSimpleLike | undefined;
let createEventStream: (() => AssistantMessageEventStream) | undefined;
try {
  const [apiMessages, eventStreams] = await Promise.all([
    import("@earendil-works/pi-ai/api/anthropic-messages"),
    import("@earendil-works/pi-ai/utils/event-stream"),
  ]);
  anthropicStreamSimple = apiMessages.streamSimple;
  createEventStream = eventStreams.createAssistantMessageEventStream;
} catch (error) {
  console.debug(
    `commandcode: pi-ai transport unavailable, registering without failover streaming (${messageOf(error)})`,
  );
}

/** Structural surface of the extension host this entry needs (satisfied by the real ExtensionAPI). */
export interface CommandCodeHost {
  readonly registerProvider: (name: string, config: ProviderConfig) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveApiBase(): string {
  const raw = process.env["COMMANDCODE_API_BASE"];
  return normalizeBase(raw === undefined || raw.length === 0 ? DEFAULT_API_BASE : raw);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandCodeKeyValidationError(`Expected whoami ${key} to be a non-empty string`);
  }
  return value;
}

function parseWhoami(payload: unknown): WhoamiInfo {
  if (!isRecord(payload)) {
    throw new CommandCodeKeyValidationError("Command Code whoami response was not an object");
  }
  const user = isRecord(payload["user"]) ? payload["user"] : payload;
  return { userId: stringField(user, "id"), userName: stringField(user, "userName") };
}

/** The whoami identity check used to both validate a fresh key and capture pool metadata. */
async function fetchWhoami(apiKey: string, apiBase: string): Promise<WhoamiInfo> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/alpha/whoami`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
  } catch (cause) {
    throw new CommandCodeKeyValidationError(`Command Code whoami request failed (${messageOf(cause)})`, { cause });
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
  return parseWhoami(payload);
}

async function addPoolAccount(store: AccountStore, apiKey: string, whoami: WhoamiInfo | undefined): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  await store.add({
    id: `oauth-${suffix}`,
    token: apiKey,
    userId: whoami?.userId,
    userName: whoami?.userName,
    keyName: `omo-${suffix}`,
  });
}

function toProviderModels(models: readonly CommandCodeModel[], baseUrl: string): ProviderModelConfig[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    baseUrl,
  }));
}

export default async function commandcodeExtension(pi: CommandCodeHost): Promise<void> {
  const apiBase = resolveApiBase();
  // The pi-ai anthropic-messages adapter appends `/v1/messages` to the model
  // baseUrl, so models must carry `{apiBase}/provider` for requests to land on
  // the Command Code provider plane (`{apiBase}/provider/v1/messages`).
  const upstreamBaseUrl = `${apiBase}/provider`;
  const store = new AccountStore({ path: resolveAccountsFilePath() });
  const pool = new AccountPool({ store });
  const billingCache = createBillingCache();

  const refreshBillingSnapshot = async (apiKey: string): Promise<void> => {
    const snapshot = await fetchBillingSnapshot({ apiKey });
    if (snapshot !== undefined) billingCache.set(apiKey, snapshot);
  };

  const failover =
    anthropicStreamSimple === undefined || createEventStream === undefined
      ? undefined
      : createFailoverStream({
          anthropicStreamSimple,
          pool,
          parseCooldown,
          billingCache,
          sessionIdFromContext: (context, callOptions) =>
            callOptions?.sessionId ?? sessionIdFromContext(context),
          createEventStream,
          now: Date.now,
          refreshBilling: (apiKey: string): void => {
            void refreshBillingSnapshot(apiKey);
          },
          resolveAccountIdByToken: async (token: string): Promise<string | undefined> => {
            const records = await store.load();
            return records.find((record) => record.token === token)?.id;
          },
        });

  const catalog = await loadModels();
  if (catalog.warning !== undefined) console.debug(`commandcode: ${catalog.warning}`);

  const login: CommandCodeLogin = (callbacks) => {
    let whoami: WhoamiInfo | undefined;
    return createLogin({
      apiBase: resolveApiBase(),
      validate: async (apiKey: string): Promise<WhoamiInfo> => {
        const info = await fetchWhoami(apiKey, resolveApiBase());
        whoami = info;
        return info;
      },
      onCredential: (apiKey: string): void => {
        void addPoolAccount(store, apiKey, whoami).catch((error: unknown) => {
          if (error instanceof AccountStoreError && /already exists/i.test(error.message)) {
            console.debug("commandcode: login credential is already present in the shared account pool");
            return;
          }
          console.warn(
            `commandcode: could not add the login credential to the shared account pool: ${messageOf(error)}`,
          );
        });
      },
    })(callbacks);
  };

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    api: "anthropic-messages",
    authHeader: true,
    baseUrl: upstreamBaseUrl,
    models: toProviderModels(catalog.models, upstreamBaseUrl),
    ...(failover === undefined ? {} : { streamSimple: failover }),
    oauth: {
      name: PROVIDER_NAME,
      login,
      refreshToken,
      getApiKey: (credentials: OAuthCredentials): string => {
        void refreshBillingSnapshot(credentials.access);
        return credentials.access;
      },
    },
  });
}
