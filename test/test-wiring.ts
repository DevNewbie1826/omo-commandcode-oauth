import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  AccountPool,
  NoCommandCodeAccountsError,
} from "../extensions/commandcode/accounts/pool.js";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";
import { createFailoverStream, type StreamSimpleLike } from "../extensions/commandcode/transport.js";

const NOW = 1_700_000_000_000;
const MODEL: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-6",
  name: "claude-sonnet-4-6",
  api: "anthropic-messages",
  provider: "commandcode",
  baseUrl: "https://api.commandcode.ai/provider",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 65_536,
};
const CONTEXT: Context = { messages: [] };
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

class HttpFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "HttpFailure";
  }
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(ids: readonly string[]): Promise<{
  readonly pool: AccountPool;
  readonly path: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "commandcode-ring-"));
  directories.push(dir);
  const path = join(dir, "accounts.json");
  const store = new AccountStore({ path, now: () => NOW });
  for (const id of ids) await store.add({ id, token: `token-${id}` });
  return { pool: new AccountPool({ store, now: () => NOW }), path };
}

function message(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    timestamp: NOW,
  };
}

function startEvent(): AssistantMessageEvent {
  return { type: "start", partial: message("stop") };
}

function doneEvent(): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: message("stop") };
}

function emit(events: readonly AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  return stream;
}

function failover(pool: AccountPool, streamSimple: StreamSimpleLike) {
  return createFailoverStream({
    pool,
    anthropicStreamSimple: streamSimple,
    createEventStream: createAssistantMessageEventStream,
    now: () => NOW,
  });
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<readonly AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function failureOf(stream: AsyncIterable<AssistantMessageEvent>): Promise<unknown> {
  return collect(stream).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("stateless request ring", () => {
  it("T1 all-429: attempts [a1,a2,a3,a4,a5,a1] and fails with FINAL-429 verbatim", async () => {
    const { pool } = await setup(["a1", "a2", "a3", "a4", "a5"]);
    const attempts: string[] = [];
    const final = new HttpFailure("FINAL-429", 429, { marker: "FINAL-429" });
    const streamSimple = failover(pool, (_model, _context, options) => {
      const id = (options?.apiKey ?? "").replace("token-", "");
      attempts.push(id);
      return Promise.reject(
        id === "a1" && attempts.length === 6
          ? final
          : new HttpFailure(`429-${id}`, 429, { marker: id }),
      );
    });

    const failure = await failureOf(streamSimple(MODEL, CONTEXT, {}));

    expect(attempts).toEqual(["a1", "a2", "a3", "a4", "a5", "a1"]);
    expect(failure).toBe(final);
    expect(failure).toMatchObject({ status: 429, body: { marker: "FINAL-429" } });
  });

  it("T2 rotate-then-success: a second request starts from a1 again", async () => {
    const { pool } = await setup(["a1", "a2"]);
    const attempts: string[] = [];
    const streamSimple = failover(pool, (_model, _context, options) => {
      const id = (options?.apiKey ?? "").replace("token-", "");
      attempts.push(id);
      return id === "a1"
        ? Promise.reject(new HttpFailure("limited", 429, { account: id }))
        : emit([startEvent(), doneEvent()]);
    });

    expect((await collect(streamSimple(MODEL, CONTEXT, {}))).at(-1)?.type).toBe("done");
    expect((await collect(streamSimple(MODEL, CONTEXT, {}))).at(-1)?.type).toBe("done");
    expect(attempts).toEqual(["a1", "a2", "a1", "a2"]);
  });

  it("T3 401 immediate: propagates the original error and never calls a2", async () => {
    const { pool } = await setup(["a1", "a2"]);
    const attempts: string[] = [];
    const unauthorized = new HttpFailure("unauthorized", 401, { error: "invalid token" });
    const streamSimple = failover(pool, (_model, _context, options) => {
      attempts.push(options?.apiKey ?? "");
      return Promise.reject(unauthorized);
    });

    expect(await failureOf(streamSimple(MODEL, CONTEXT, {}))).toBe(unauthorized);
    expect(attempts).toEqual(["token-a1"]);
  });

  it("T4 post-output failure: propagates without replay", async () => {
    const { pool } = await setup(["a1", "a2"]);
    const attempts: string[] = [];
    const terminal = new HttpFailure("mid-stream", 500, { partial: true });
    const streamSimple = failover(pool, (_model, _context, options) => {
      attempts.push(options?.apiKey ?? "");
      const stream = createAssistantMessageEventStream();
      stream.push(startEvent());
      stream.fail(terminal);
      return stream;
    });

    expect(await failureOf(streamSimple(MODEL, CONTEXT, {}))).toBe(terminal);
    expect(attempts).toEqual(["token-a1"]);
  });

  it("T5 file untouched: full rotation changes neither content nor mtime", async () => {
    const { pool, path } = await setup(["a1", "a2", "a3"]);
    const beforeContent = await readFile(path);
    const beforeMtime = (await stat(path, { bigint: true })).mtimeNs;
    const streamSimple = failover(pool, () =>
      Promise.reject(new HttpFailure("limited", 429, { limited: true })),
    );

    await failureOf(streamSimple(MODEL, CONTEXT, {}));

    expect(await readFile(path)).toEqual(beforeContent);
    expect((await stat(path, { bigint: true })).mtimeNs).toBe(beforeMtime);
  });

  it("T6 zero accounts: selection fails with the typed error", async () => {
    const { pool } = await setup([]);
    const streamSimple = failover(pool, () => emit([doneEvent()]));

    const failure = await failureOf(streamSimple(MODEL, CONTEXT, {}));
    expect(failure).toBeInstanceOf(NoCommandCodeAccountsError);
    expect(failure).toMatchObject({ message: "No Command Code accounts" });
  });

  it("replaces host Authorization with the selected account token", async () => {
    const { pool } = await setup(["a1"]);
    let observed: SimpleStreamOptions | undefined;
    const streamSimple = failover(pool, (_model, _context, options) => {
      observed = options;
      return emit([doneEvent()]);
    });

    await collect(streamSimple(MODEL, CONTEXT, {
      apiKey: "host-token",
      headers: { Authorization: "Bearer host-token" },
    }));

    expect(observed?.apiKey).toBe("token-a1");
    expect(observed?.headers?.["Authorization"]).toBe("Bearer token-a1");
  });
});
