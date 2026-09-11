import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AccountPool } from "./accounts/pool.js";
import { classifyFailure, type ClassifyFailureInput } from "./ratelimit.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type StreamSimpleResult = AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type StreamSimpleLike = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
) => StreamSimpleResult;

export type FailoverStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface FailoverStreamOptions {
  readonly anthropicStreamSimple: StreamSimpleLike;
  readonly pool: AccountPool;
  readonly createEventStream: () => AssistantMessageEventStream;
  readonly now?: () => number;
  readonly refreshBilling?: (apiKey: string) => void;
}

type Failure = {
  readonly classification: ClassifyFailureInput;
  readonly original: unknown;
  readonly event?: AssistantMessageEvent;
};

type AttemptOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "failed-before-output"; readonly failure: Failure }
  | { readonly kind: "failed-after-output"; readonly failure: Failure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFromMessage(message: string): number | undefined {
  const match = /^(\d{3})(?:\s|$)/.exec(message);
  return match === null ? undefined : Number(match[1]);
}

function embeddedBody(message: string): unknown {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(message.slice(start, end + 1)) as unknown;
  } catch (_error: unknown) {
    return undefined;
  }
}

function thrownFailure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const statusValue = isRecord(error) ? error["status"] : undefined;
  const status = typeof statusValue === "number" ? statusValue : statusFromMessage(message);
  const body = isRecord(error) ? error["body"] : undefined;
  return {
    original: error,
    classification: {
      status,
      body: body ?? embeddedBody(message),
      message,
      network: status === undefined,
    },
  };
}

function eventFailure(event: Extract<AssistantMessageEvent, { readonly type: "error" }>): Failure {
  const message = event.error.errorMessage ?? "Command Code request failed";
  return {
    original: event,
    event,
    classification: {
      status: statusFromMessage(message),
      body: embeddedBody(message),
      message,
      network: false,
    },
  };
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function unsupportedModelEvent(model: Model<Api>, now: number): AssistantMessageEvent {
  const failed: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: `Command Code transport requires an anthropic-messages model (received api "${model.api}")`,
    timestamp: now,
  };
  return { type: "error", reason: "error", error: failed };
}

function surface(outer: AssistantMessageEventStream, failure: Failure): void {
  if (failure.event !== undefined) outer.push(failure.event);
  else outer.fail(failure.original);
}

export function createFailoverStream(options: FailoverStreamOptions): FailoverStreamSimple {
  const attempt = async (
    token: string,
    model: Model<"anthropic-messages">,
    context: Context,
    callOptions: SimpleStreamOptions | undefined,
    outer: AssistantMessageEventStream,
  ): Promise<AttemptOutcome> => {
    let inner: AssistantMessageEventStream;
    try {
      const result = options.anthropicStreamSimple(model, context, {
        ...callOptions,
        apiKey: token,
        headers: { ...callOptions?.headers, Authorization: `Bearer ${token}` },
      });
      inner = result instanceof Promise ? await result : result;
    } catch (error: unknown) {
      return { kind: "failed-before-output", failure: thrownFailure(error) };
    }

    let forwarded = false;
    try {
      for await (const event of inner) {
        if (event.type === "error") {
          return {
            kind: forwarded ? "failed-after-output" : "failed-before-output",
            failure: eventFailure(event),
          };
        }
        forwarded = true;
        outer.push(event);
      }
      return { kind: "completed" };
    } catch (error: unknown) {
      return {
        kind: forwarded ? "failed-after-output" : "failed-before-output",
        failure: thrownFailure(error),
      };
    }
  };

  const drive = async (
    outer: AssistantMessageEventStream,
    model: Model<"anthropic-messages">,
    context: Context,
    callOptions: SimpleStreamOptions | undefined,
  ): Promise<void> => {
    try {
      const ordered = await options.pool.ordered();
      const attempts = [...ordered, ordered[0]];
      for (let index = 0; index < attempts.length; index += 1) {
        const account = attempts[index];
        if (account === undefined) throw new Error("Account ordering invariant failed");
        const outcome = await attempt(account.token, model, context, callOptions, outer);
        if (outcome.kind === "completed") {
          outer.end();
          return;
        }
        if (outcome.kind === "failed-after-output") {
          surface(outer, outcome.failure);
          return;
        }
        if (
          classifyFailure(outcome.failure.classification) === "propagate" ||
          index === attempts.length - 1
        ) {
          surface(outer, outcome.failure);
          return;
        }
        options.refreshBilling?.(account.token);
      }
    } catch (error: unknown) {
      outer.fail(error);
    }
  };

  return (model, context, callOptions) => {
    const outer = options.createEventStream();
    if (!isAnthropicMessagesModel(model)) {
      outer.push(unsupportedModelEvent(model, (options.now ?? Date.now)()));
      return outer;
    }
    void drive(outer, model, context, callOptions);
    return outer;
  };
}
