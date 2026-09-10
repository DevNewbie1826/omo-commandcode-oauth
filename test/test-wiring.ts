import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AccountPool } from "../extensions/commandcode/accounts/pool.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";
import { createBillingCache } from "../extensions/commandcode/billing.js";
import { parseCooldown } from "../extensions/commandcode/ratelimit.js";
import {
  createFailoverStream,
  type StreamSimpleLike,
} from "../extensions/commandcode/transport.js";
import commandcodeExtension from "../extensions/commandcode/index.js";

const BASE_MS = 1_700_000_000_000;
const RESET_SECONDS = 1_758_000_000;
const RESET_ISO = new Date(RESET_SECONDS * 1000).toISOString();
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

const MODEL: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-6",
  name: "claude-sonnet-4-6",
  api: "anthropic-messages",
  provider: "commandcode",
  baseUrl: "https://api.commandcode.ai",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 65_536,
};

const CONTEXT: Context = { messages: [] };

class HttpFailure extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "HttpFailure";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

interface Clock {
  readonly now: () => number;
}

function makeClock(startMs: number = BASE_MS): Clock {
  const nowMs = startMs;
  return { now: () => nowMs };
}

const staleDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const dirs = staleDirs.splice(0, staleDirs.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-wiring-"));
  staleDirs.push(dir);
  return dir;
}

async function setupPool(ids: readonly string[]): Promise<{
  readonly store: AccountStore;
  readonly pool: AccountPool;
  readonly clock: Clock;
}> {
  const dir = await tempDir();
  const clock = makeClock();
  const store = new AccountStore({ path: join(dir, "accounts.json"), now: clock.now });
  for (const id of ids) {
    await store.add({ id, token: `token-${id}`, createdAt: new Date(clock.now()).toISOString() });
  }
  return { store, pool: new AccountPool({ store, now: clock.now }), clock };
}

function assistantMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "commandcode",
    model: MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    errorMessage,
    timestamp: BASE_MS,
  };
}

function startEvent(): AssistantMessageEvent {
  return { type: "start", partial: assistantMessage("stop") };
}

function doneEvent(): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: assistantMessage("stop") };
}

function errorEvent(message: string): AssistantMessageEvent {
  return { type: "error", reason: "error", error: assistantMessage("error", message) };
}

function emit(events: readonly AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<readonly AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function errorMessageOf(events: readonly AssistantMessageEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "error") return event.error.errorMessage;
  }
  return undefined;
}

function retryAfterFailure(): HttpFailure {
  return new HttpFailure("rate limited", 429, {}, { "retry-after": "30" });
}

function resetBodyFailure(): HttpFailure {
  return new HttpFailure("rate limited", 429, {
    error: {
      code: "RATE_LIMITED",
      rateLimit: { window: "daily", reset: RESET_SECONDS },
    },
  });
}

function failover(options: {
  readonly pool: AccountPool;
  readonly clock: Clock;
  readonly anthropicStreamSimple: StreamSimpleLike;
}) {
  return createFailoverStream({
    anthropicStreamSimple: options.anthropicStreamSimple,
    pool: options.pool,
    parseCooldown,
    billingCache: createBillingCache({ now: options.clock.now }),
    sessionIdFromContext: () => "session-test",
    createEventStream: createAssistantMessageEventStream,
    now: options.clock.now,
    refreshBilling: () => undefined,
  });
}

describe("createFailoverStream", () => {
  it("Given account1 fails with a 429 before emitting, When the wrapper streams, Then it quarantines account1 and forwards account2 events", async () => {
    const { store, pool, clock } = await setupPool(["account1", "account2"]);
    const seen: string[] = [];
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
        const token = options?.apiKey ?? "";
        seen.push(token);
        if (token === "token-account1") return Promise.reject(retryAfterFailure());
        return emit([startEvent(), doneEvent()]);
      },
    });

    const events = await collect(streamSimple(MODEL, CONTEXT, {}));
    const records = await store.load();
    const quarantined = records.find((record) => record.id === "account1");

    expect(seen).toEqual(["token-account1", "token-account2"]);
    expect(quarantined?.retryAt).toBe(BASE_MS + 30_000);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("Given account1 fails with a body-declared reset before emitting, When the wrapper streams, Then it quarantines account1 until that reset and retries with account2", async () => {
    const { store, pool, clock } = await setupPool(["account1", "account2"]);
    const seen: string[] = [];
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
        const token = options?.apiKey ?? "";
        seen.push(token);
        if (token === "token-account1") return Promise.reject(resetBodyFailure());
        return emit([startEvent(), doneEvent()]);
      },
    });

    const events = await collect(streamSimple(MODEL, CONTEXT, {}));
    const records = await store.load();
    const quarantined = records.find((record) => record.id === "account1");

    expect(seen).toEqual(["token-account1", "token-account2"]);
    expect(quarantined?.retryAt).toBe(RESET_SECONDS * 1000);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(streamSimple).toBeTypeOf("function");
  });

  it("Given account1 fails with a non-cooldown 401 before emitting, When the wrapper streams, Then the failure propagates without quarantine or retry", async () => {
    const { store, pool, clock } = await setupPool(["account1", "account2"]);
    const seen: string[] = [];
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
        const token = options?.apiKey ?? "";
        seen.push(token);
        if (token === "token-account1") return Promise.reject(new HttpFailure("invalid key", 401, {}));
        return emit([startEvent(), doneEvent()]);
      },
    });

    const events = await collect(streamSimple(MODEL, CONTEXT, {}));
    const records = await store.load();

    expect(seen).toEqual(["token-account1"]);
    expect(records.find((record) => record.id === "account1")?.retryAt).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(errorMessageOf(events)).toBe("invalid key");
  });

  it("Given account1 errors after the first forwarded event, When the wrapper streams, Then the outer stream fails and account2 is never called", async () => {
    const { pool, clock } = await setupPool(["account1", "account2"]);
    const seen: string[] = [];
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
        const token = options?.apiKey ?? "";
        seen.push(token);
        return emit([startEvent(), errorEvent("mid-stream failure")]);
      },
    });

    const events = await collect(streamSimple(MODEL, CONTEXT, {}));

    expect(seen).toEqual(["token-account1"]);
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(errorMessageOf(events)).toBe("mid-stream failure");
  });

  it("Given every account is rate-limited, When the wrapper streams, Then the outer stream fails with a NoHealthyAccounts message containing the reset ISO", async () => {
    const { pool, clock } = await setupPool(["account1", "account2"]);
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: () => Promise.reject(resetBodyFailure()),
    });

    const events = await collect(streamSimple(MODEL, CONTEXT, {}));

    expect(errorMessageOf(events)).toContain(RESET_ISO);
    expect(errorMessageOf(events)).toMatch(/No healthy Command Code accounts/i);
  });
});

describe("commandcode registerProvider", () => {
  it("Given fetch is disabled via env, When the extension registers, Then oauth.login is a function, api is anthropic-messages, and models is non-empty", async () => {
    const dir = await tempDir();
    vi.stubEnv("COMMANDCODE_API_BASE", "http://127.0.0.1:1");
    vi.stubEnv("COMMANDCODE_MODELS_CACHE", join(dir, "models.json"));
    vi.stubEnv("COMMANDCODE_ACCOUNTS_FILE", join(dir, "accounts.json"));
    vi.stubGlobal("fetch", () => Promise.reject(new Error("fetch disabled")));

    type Registered = { name: string; config: ProviderConfig };
    type Host = { registerProvider(name: string, config: ProviderConfig): void };

    let captured: Registered | undefined;
    const pi: Host = {
      registerProvider(name, config) {
        captured = { name, config };
      },
    };

    await commandcodeExtension(pi);

    expect(captured?.name).toBe("commandcode");
    expect(captured?.config.name).toBe("Command Code (unofficial)");
    expect(captured?.config.api).toBe("anthropic-messages");
    expect(captured?.config.authHeader).toBe(true);
    expect(captured?.config.baseUrl).toBe("http://127.0.0.1:1");
    expect(typeof captured?.config.oauth?.login).toBe("function");
    expect(captured?.config.models?.length).toBeGreaterThan(0);
    expect(captured?.config.oauth?.getApiKey({ access: "k", refresh: "k", expires: 0 })).toBe("k");
  });
});
