import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { streamSimple as realAnthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AccountPool } from "../extensions/commandcode/accounts/pool.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";
import { closeServer } from "../extensions/commandcode/auth-server.js";
import { createBillingCache, type BillingSnapshot } from "../extensions/commandcode/billing.js";
import { parseCooldown } from "../extensions/commandcode/ratelimit.js";
import {
  createFailoverStream,
  type StreamSimpleLike,
} from "../extensions/commandcode/transport.js";
import commandcodeExtension, { createPinnedAccountResolver } from "../extensions/commandcode/index.js";

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
const staleServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const servers = staleServers.splice(0, staleServers.length);
  const dirs = staleDirs.splice(0, staleDirs.length);
  await Promise.all([
    ...servers.map((server) => closeServer(server)),
    ...dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
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
  readonly resolveAccountIdByToken?: (token: string) => Promise<string | undefined>;
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
    ...(options.resolveAccountIdByToken === undefined
      ? {}
      : { resolveAccountIdByToken: options.resolveAccountIdByToken }),
  });
}

// ---------------------------------------------------------------------------
// Real-adapter wire harness (loopback anthropic-messages double)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  readonly pathname: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
}

interface RecordingServer {
  readonly port: number;
  readonly requests: readonly RecordedRequest[];
  readonly server: Server;
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Minimal valid anthropic-messages SSE stream (one text block, end_turn). */
const ANTHROPIC_SSE_SUCCESS = [
  sse("message_start", {
    type: "message_start",
    message: {
      id: "msg_wire-1",
      type: "message",
      role: "assistant",
      content: [],
      model: MODEL.id,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }),
  sse("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  sse("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" },
  }),
  sse("content_block_stop", { type: "content_block_stop", index: 0 }),
  sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  }),
  sse("message_stop", { type: "message_stop" }),
].join("");

function rateLimitedBody(): unknown {
  return {
    type: "error",
    error: { type: "rate_limit_error" },
    rateLimit: { window: "daily", reset: RESET_SECONDS },
  };
}

/** Records {path, authorization, x-api-key} per request; 429s every token except token-b (SSE success). */
function startRecordingAnthropicServer(): Promise<RecordingServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    request.resume();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const authorization =
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
    const apiKey =
      typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
    requests.push({ pathname, authorization, apiKey });
    if (authorization !== "Bearer token-b") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify(rateLimitedBody()));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(ANTHROPIC_SSE_SUCCESS);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected the recording server to bind a TCP port"));
        return;
      }
      resolve({ port: address.port, requests, server });
    });
  });
}

function onAuthSignal(): { readonly onAuth: OAuthLoginCallbacks["onAuth"]; readonly url: Promise<string> } {
  let resolveUrl: ((url: string) => void) | undefined;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const onAuth: OAuthLoginCallbacks["onAuth"] = (info) => resolveUrl?.(info.url);
  return { onAuth, url };
}

/** Intercept whoami with a valid identity; everything else (loopback callback, models) goes to the real fetch. */
function stubWhoamiApi(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/alpha/whoami")) {
        return new Response(JSON.stringify({ user: { id: "u-1", userName: "tester" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    }),
  );
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

describe("createFailoverStream (real adapter wire)", () => {
  it("Given a host-pinned Authorization preset and a rate-limited first account, When the real pi-ai streamSimple drives the failover wrapper, Then exactly two requests hit /provider/v1/messages carrying Bearer token-a then Bearer token-b", async () => {
    const { store, pool, clock } = await setupPool(["a", "b"]);
    const recording = await startRecordingAnthropicServer();
    staleServers.push(recording.server);

    const wireModel: Model<"anthropic-messages"> = {
      ...MODEL,
      baseUrl: `http://127.0.0.1:${recording.port}/provider`,
    };
    const streamSimple = failover({ pool, clock, anthropicStreamSimple: realAnthropicStreamSimple });

    // Hosts with authHeader providers inject a preset Authorization header; the
    // second attempt must not leak it onto the wire.
    const events = await collect(
      streamSimple(wireModel, CONTEXT, { headers: { Authorization: "Bearer token-a" } }),
    );

    expect(recording.requests).toHaveLength(2);
    expect(recording.requests.map((request) => request.pathname)).toEqual([
      "/provider/v1/messages",
      "/provider/v1/messages",
    ]);
    expect(recording.requests.map((request) => request.authorization)).toEqual([
      "Bearer token-a",
      "Bearer token-b",
    ]);
    expect(recording.requests.map((request) => request.apiKey)).toEqual(["token-a", "token-b"]);
    expect(events.at(-1)?.type).toBe("done");
    expect(JSON.stringify(events)).toContain("hello");
    const records = await store.load();
    expect(records.find((record) => record.id === "a")?.retryAt).toBeDefined();
  });
});

describe("pinned options.apiKey", () => {
  it("Given the pinned account is cooling down, When the host pins its token, Then rotation falls through to the healthy other account", async () => {
    const { store, pool, clock } = await setupPool(["account1", "account2"]);
    await pool.quarantine("account1", clock.now() + 60_000);
    const seen: string[] = [];
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
        seen.push(options?.apiKey ?? "");
        return emit([startEvent(), doneEvent()]);
      },
      resolveAccountIdByToken: createPinnedAccountResolver(store, clock.now),
    });

    const events = await collect(
      streamSimple(MODEL, CONTEXT, { apiKey: "token-account1", sessionId: "session-pinned" }),
    );

    expect(seen).toEqual(["token-account2"]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("Given the pinned account is disabled, When the host pins its token, Then rotation falls through to the healthy other account", async () => {
    const { store, pool, clock } = await setupPool(["account1", "account2"]);
    await store.setEnabled("account1", false);
    const seen: string[] = [];
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
        seen.push(options?.apiKey ?? "");
        return emit([startEvent(), doneEvent()]);
      },
      resolveAccountIdByToken: createPinnedAccountResolver(store, clock.now),
    });

    const events = await collect(
      streamSimple(MODEL, CONTEXT, { apiKey: "token-account1", sessionId: "session-pinned" }),
    );

    expect(seen).toEqual(["token-account2"]);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("Given the pinned account is healthy, When the host pins its token, Then the pinned account is used and sticky bindings survive the pinned request", async () => {
    const { store, pool, clock } = await setupPool(["account1", "account2"]);
    const seen: string[] = [];
    const adapter: StreamSimpleLike = (_model, _context, options) => {
      seen.push(options?.apiKey ?? "");
      return emit([startEvent(), doneEvent()]);
    };
    const streamSimple = failover({
      pool,
      clock,
      anthropicStreamSimple: adapter,
      resolveAccountIdByToken: createPinnedAccountResolver(store, clock.now),
    });

    // Seed a sticky session binding on account1.
    await collect(streamSimple(MODEL, CONTEXT, { sessionId: "session-sticky" }));
    // The healthy pinned account is attempted first...
    await collect(
      streamSimple(MODEL, CONTEXT, { sessionId: "session-sticky", apiKey: "token-account2" }),
    );
    // ...and the next unpinned request still resolves through the untouched binding.
    await collect(streamSimple(MODEL, CONTEXT, { sessionId: "session-sticky" }));

    expect(seen).toEqual(["token-account1", "token-account2", "token-account1"]);
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
    // The anthropic-messages adapter appends /v1/messages to the model baseUrl;
    // registering {apiBase}/provider lands requests on {apiBase}/provider/v1/messages.
    expect(captured?.config.baseUrl).toBe("http://127.0.0.1:1/provider");
    expect(captured?.config.models?.length).toBeGreaterThan(0);
    expect(
      captured?.config.models?.every(
        (model) => model.baseUrl === "http://127.0.0.1:1/provider",
      ),
    ).toBe(true);
    expect(captured?.config.oauth?.getApiKey({ access: "k", refresh: "k", expires: 0 })).toBe("k");
  });
});
