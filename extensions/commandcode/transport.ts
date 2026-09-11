import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AccountPool } from "./accounts/pool.js";
import { classifyFailure, type ClassifyFailureInput } from "./ratelimit.js";
import type { CommandCodeApi } from "./models.js";

export type StreamSimpleResult = AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
export type StreamSimpleLike<TApi extends CommandCodeApi = "anthropic-messages"> = (
  model: Model<TApi>, context: Context, options?: SimpleStreamOptions,
) => StreamSimpleResult;
export type FailoverStreamSimple = (
  model: Model<Api>, context: Context, options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
export interface FailoverStreamOptions {
  readonly anthropicStreamSimple: StreamSimpleLike<"anthropic-messages">;
  readonly openaiStreamSimple: StreamSimpleLike<"openai-completions">;
  readonly pool: AccountPool;
  readonly createEventStream: () => AssistantMessageEventStream;
  readonly refreshBilling?: (apiKey: string) => void;
}

export class UnsupportedCommandCodeApiError extends Error {
  constructor(api: Api) {
    super(`Command Code transport does not support api "${api}"`);
    this.name = "UnsupportedCommandCodeApiError";
  }
}

class AccountOrderingInvariantError extends Error {
  constructor() {
    super("Account ordering invariant failed");
    this.name = "AccountOrderingInvariantError";
  }
}

type UpstreamResponseFailure = Readonly<{
  status: number; body: string; headers: Readonly<Record<string, string>>;
}>;
type Failure = {
  readonly classification: ClassifyFailureInput;
  readonly original: unknown;
  readonly event?: AssistantMessageEvent;
};
type AttemptOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "failed-before-output"; readonly failure: Failure }
  | { readonly kind: "failed-after-output"; readonly failure: Failure };
type SelectedAdapter = (context: Context, options?: SimpleStreamOptions) => StreamSimpleResult;

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
  const name = error instanceof Error ? error.name : undefined;
  const code = isRecord(error) ? error["code"] : undefined;
  const network = status === undefined && (name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" || (typeof code === "string" &&
    /^(?:ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/.test(code)) || (error instanceof TypeError &&
    /fetch|network|socket|connect/i.test(message)));
  return {
    original: error,
    classification: { status, body: body ?? embeddedBody(message), message, network },
  };
}
function eventFailure(
  event: Extract<AssistantMessageEvent, { readonly type: "error" }>,
  upstream?: UpstreamResponseFailure,
): Failure {
  const message = event.error.errorMessage ?? "Command Code request failed";
  const diagnostic = [...(event.error.diagnostics ?? [])].reverse().find(
    (entry) => entry.type === "provider_retry_failure",
  );
  const statusCode = diagnostic?.details?.["statusCode"];
  const status = upstream?.status ??
    (typeof statusCode === "number" ? statusCode : statusFromMessage(message));
  const kind = diagnostic?.details?.["kind"];
  if (upstream !== undefined) {
    const enriched = event.error as AssistantMessage & {
      upstreamStatus: number; upstreamBody: string; upstreamHeaders: Readonly<Record<string, string>>;
    };
    enriched.upstreamStatus = upstream.status;
    enriched.upstreamBody = upstream.body;
    enriched.upstreamHeaders = upstream.headers;
    enriched.errorMessage = upstream.body;
  }
  return {
    original: event,
    event,
    classification: {
      status,
      body: upstream?.body ?? embeddedBody(message),
      message,
      network: kind === "connection" || kind === "timeout" || kind === "network",
    },
  };
}
function recordingFetch(baseFetch: typeof fetch, record: (failure: UpstreamResponseFailure) => void): typeof fetch {
  let firstResponse: Promise<Response> | undefined;
  let failure: UpstreamResponseFailure | undefined;
  return async (input, init) => {
    const initial = firstResponse === undefined;
    firstResponse ??= baseFetch(input, init).then(async (response) => {
      if (!response.ok) {
        const body = await response.clone().text();
        failure = { status: response.status, body, headers: Object.fromEntries(response.headers) };
        record(failure);
      }
      return response;
    });
    const response = await firstResponse;
    if (initial) return response;
    if (failure === undefined) return baseFetch(input, init);
    return new Response(failure.body, { status: failure.status, headers: failure.headers });
  };
}
function isModel<TApi extends CommandCodeApi>(model: Model<Api>, api: TApi): model is Model<TApi> {
  return model.api === api;
}
function selectAdapter(options: FailoverStreamOptions, model: Model<Api>): SelectedAdapter {
  if (isModel(model, "anthropic-messages")) {
    return (context, callOptions) => options.anthropicStreamSimple(model, context, callOptions);
  }
  if (isModel(model, "openai-completions")) {
    return (context, callOptions) => options.openaiStreamSimple(model, context, callOptions);
  }
  throw new UnsupportedCommandCodeApiError(model.api);
}
function surface(outer: AssistantMessageEventStream, failure: Failure): void {
  if (failure.event !== undefined) outer.push(failure.event);
  else outer.fail(failure.original);
}

export function createFailoverStream(options: FailoverStreamOptions): FailoverStreamSimple {
  const attempt = async (
    token: string,
    adapter: SelectedAdapter,
    context: Context,
    callOptions: SimpleStreamOptions | undefined,
    outer: AssistantMessageEventStream,
  ): Promise<AttemptOutcome> => {
    let inner: AssistantMessageEventStream;
    let upstreamFailure: UpstreamResponseFailure | undefined;
    const fetchImpl = recordingFetch(callOptions?.fetch ?? fetch, (failure) => {
      upstreamFailure = failure;
    });
    try {
      inner = await adapter(context, {
        ...callOptions,
        apiKey: token,
        headers: { ...callOptions?.headers, Authorization: `Bearer ${token}` },
        maxRetries: 0,
        fetch: fetchImpl,
      });
    } catch (error: unknown) {
      return { kind: "failed-before-output", failure: thrownFailure(error) };
    }
    let forwarded = false;
    try {
      for await (const event of inner) {
        if (event.type === "error") {
          return {
            kind: forwarded ? "failed-after-output" : "failed-before-output",
            failure: eventFailure(event, upstreamFailure),
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
    adapter: SelectedAdapter,
    context: Context,
    callOptions: SimpleStreamOptions | undefined,
  ): Promise<void> => {
    try {
      const ordered = await options.pool.ordered();
      const first = ordered[0];
      if (first === undefined) throw new AccountOrderingInvariantError();
      const attempts = [...ordered, first];
      for (let index = 0; index < attempts.length; index += 1) {
        const account = attempts[index];
        if (account === undefined) throw new AccountOrderingInvariantError();
        const outcome = await attempt(account.token, adapter, context, callOptions, outer);
        if (outcome.kind === "completed") {
          outer.end();
          return;
        }
        if (outcome.kind === "failed-after-output") {
          surface(outer, outcome.failure);
          return;
        }
        if (classifyFailure(outcome.failure.classification) === "propagate" ||
          index === attempts.length - 1) {
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
    try {
      void drive(outer, selectAdapter(options, model), context, callOptions);
    } catch (error: unknown) {
      outer.fail(error);
    }
    return outer;
  };
}
