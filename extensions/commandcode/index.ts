import { randomUUID } from "node:crypto";
import type { ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";
import type {
  AssistantMessageEventStream,
  OAuthCredentials,
} from "@earendil-works/pi-ai/compat";
import { AccountPool } from "./accounts/pool.js";
import { AccountStoreError } from "./accounts/schema.js";
import { AccountStore, resolveAccountsFilePath } from "./accounts/store.js";
import { createBillingCache, createBillingRefresher } from "./billing.js";
import { loadModels, type CommandCodeModel } from "./models.js";
import {
  CommandCodeInvalidKeyError,
  CommandCodeKeyValidationError,
  CommandCodeLoginError,
  DEFAULT_API_BASE,
  createLogin,
  refreshToken,
  type CommandCodeLogin,
  type WhoamiInfo,
} from "./oauth.js";
import { createFailoverStream, type StreamSimpleLike } from "./transport.js";

export { createBillingRefresher };

const PROVIDER_ID = "commandcode";
const PROVIDER_NAME = "Command Code (unofficial)";

/** The host exposes pi-ai's compatibility surface to extensions as one virtual module. */
const PI_AI_COMPAT_SPECIFIER = "@earendil-works/pi-ai/compat";
let compatStreamSimple: StreamSimpleLike | undefined;
let createEventStream: (() => AssistantMessageEventStream) | undefined;
try {
  const compat = await import("@earendil-works/pi-ai/compat");
  compatStreamSimple = compat.streamSimple;
  createEventStream = compat.createAssistantMessageEventStream;
} catch (error) {
  console.debug(
    `commandcode: pi-ai transport unavailable: specifier "${PI_AI_COMPAT_SPECIFIER}" failed; ` +
      `registering without failover streaming (${messageOf(error)})`,
  );
}

export interface CommandCodeHost {
  readonly registerProvider: (name: string, config: ProviderConfig) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveApiBase(): string {
  const raw = process.env["COMMANDCODE_API_BASE"];
  return (raw === undefined || raw.length === 0 ? DEFAULT_API_BASE : raw).replace(/\/+$/, "");
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

function toProviderModels(models: readonly CommandCodeModel[], apiBase: string): ProviderModelConfig[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    baseUrl: model.api === "anthropic-messages" ? `${apiBase}/provider` : `${apiBase}/provider/v1`,
  }));
}

export default async function commandcodeExtension(pi: CommandCodeHost): Promise<void> {
  const apiBase = resolveApiBase();
  // Each adapter appends its own endpoint: Anthropic needs `/provider`, while
  // the OpenAI SDK needs `/provider/v1` before appending `/chat/completions`.
  const upstreamBaseUrl = `${apiBase}/provider`;
  const store = new AccountStore({ path: resolveAccountsFilePath() });
  const pool = new AccountPool({ store });
  const billingCache = createBillingCache();
  const refreshBillingSnapshot = createBillingRefresher({ pool, billingCache });
  void store.load().then(
    (records) => Promise.all(records.filter((record) => record.enabled).map((record) =>
      refreshBillingSnapshot(record.token),
    )),
    (error: unknown) => {
      console.debug(`commandcode: could not load accounts for billing polling (${messageOf(error)})`);
    },
  );

  const failover =
    compatStreamSimple === undefined || createEventStream === undefined
      ? undefined
      : createFailoverStream({
          streamSimple: compatStreamSimple,
          pool,
          createEventStream,
          refreshBilling: (apiKey: string): void => {
            void refreshBillingSnapshot(apiKey);
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
      onCredential: (apiKey: string): Promise<void> =>
        addPoolAccount(store, apiKey, whoami)
          .catch((error: unknown) => {
            if (error instanceof AccountStoreError && /already exists/i.test(error.message)) {
              console.debug("commandcode: login credential is already present in the shared account pool");
              return;
            }
            // Persistence failures must fail the login: a credential that never
            // reached the shared pool would silently vanish for other sessions.
            throw new CommandCodeLoginError(
              `Could not add the login credential to the shared account pool: ${messageOf(error)}`,
              { cause: error },
            );
          })
          .then(() => {
            void refreshBillingSnapshot(apiKey);
          }),
    })(callbacks);
  };

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    api: "anthropic-messages",
    authHeader: true,
    baseUrl: upstreamBaseUrl,
    models: toProviderModels(catalog.models, apiBase),
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
