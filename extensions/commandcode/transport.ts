/**
 * Failover transport for the Command Code provider.
 *
 * Wraps the pi-ai anthropic-messages `streamSimple` so that a request which
 * is rate-limited or out of credits BEFORE its first forwarded event is
 * retried on the next account of the shared pool (each account at most once
 * per request), while anything already observed by the consumer is never
 * replayed: once an event has been forwarded, a failure is propagated as-is.
 *
 * The real pi-ai adapter reports request failures as a terminal `error`
 * event as the first stream event (HTTP status and body folded into the
 * message, e.g. Anthropic SDK `APIError.message`); direct call sites may
 * also surface rejections. Both styles are fed into `parseCooldown`.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  Model,
  ProviderNativeContent,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AccountPool } from "./accounts/pool.js";
import type { BillingCache } from "./billing.js";
import type { CooldownDecision, ParseCooldownInput } from "./ratelimit.js";

/** Quarantine fallback when a cooldown decision carries no reset time. */
const DEFAULT_COOLDOWN_MS = 60_000;

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The real pi-ai module resolves synchronously; tests and adapters may reject instead. */
export type StreamSimpleResult = AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/** Narrow pi-ai stream contract, matching `@earendil-works/pi-ai/api/anthropic-messages`. */
export type StreamSimpleLike = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
) => StreamSimpleResult;

/** Wide stream contract registered on the provider config. */
export type FailoverStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface FailoverStreamOptions {
  readonly anthropicStreamSimple: StreamSimpleLike;
  readonly pool: AccountPool;
  readonly parseCooldown: (input: ParseCooldownInput) => CooldownDecision | null;
  readonly billingCache: BillingCache;
  readonly sessionIdFromContext: (context: Context, options?: SimpleStreamOptions) => string;
  readonly createEventStream: () => AssistantMessageEventStream;
  readonly now: () => number;
  /** Fire-and-forget billing refresh hook; implementers must not reject. */
  readonly refreshBilling: (apiKey: string) => void;
  /**
   * Maps an explicit `options.apiKey` to a pool account id. When provided and
   * the key belongs to the pool, that account is attempted first (pinned);
   * otherwise rotation starts from `pool.next`.
   */
  readonly resolveAccountIdByToken?: (token: string) => Promise<string | undefined>;
}

type PinnedAccount = {
  readonly id: string;
  readonly token: string;
};

/** Everything `parseCooldown` might need, extracted from either failure style. */
type FailureCause = {
  readonly message: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: unknown;
};

type AttemptOutcome =
  | { readonly kind: "completed" }
  | {
      readonly kind: "failed-before-first-event";
      readonly cause: FailureCause;
      /** Original terminal error event, replayed only when the failure is not a cooldown. */
      readonly replay?: AssistantMessageEvent;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Anthropic SDK `APIError.message` leads with the HTTP status ("429 …"). */
function statusFromMessage(message: string): number | undefined {
  const match = /^(\d{3})\s/.exec(message);
  const status = match?.[1];
  return status === undefined ? undefined : Number(status);
}

function embeddedJsonBody(message: string): Record<string, unknown> | undefined {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(start, end + 1));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function headersFrom(value: unknown): Record<string, string> | undefined {
  if (value instanceof Headers) {
    const headers: Record<string, string> = {};
    value.forEach((entry, key) => {
      headers[key] = entry;
    });
    return headers;
  }
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") headers[key] = entry;
  }
  return headers;
}

function cooldownBodyOf(cause: FailureCause): unknown {
  if (typeof cause.body === "string" || isRecord(cause.body)) return cause.body;
  return embeddedJsonBody(cause.message) ?? { error: { message: cause.message } };
}

function cooldownInputOf(cause: FailureCause, nowMs: number): ParseCooldownInput {
  return {
    status: cause.status ?? statusFromMessage(cause.message) ?? 0,
    body: cooldownBodyOf(cause),
    headers: headersFrom(cause.headers),
    now: nowMs,
  };
}

function failureFromThrown(error: unknown): FailureCause {
  const message = messageOf(error);
  if (!isRecord(error)) return { message };
  const body = error["body"];
  return {
    message,
    status: optionalNumber(error, "status"),
    body: typeof body === "string" || isRecord(body) ? body : undefined,
    headers: error["headers"],
  };
}

function failureFromAssistantMessage(error: AssistantMessage): FailureCause {
  return { message: error.errorMessage ?? "Command Code request failed" };
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

function errorMessageEvent(model: Model<Api>, message: string, timestampMs: number): AssistantMessageEvent {
  const failed: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: "error",
    errorMessage: message,
    timestamp: timestampMs,
  };
  return { type: "error", reason: "error", error: failed };
}

type StreamContentPart = TextContent | ThinkingContent | ToolCall | ImageContent | ProviderNativeContent;

function contentPartKey(part: StreamContentPart): string {
  switch (part.type) {
    case "text":
      return `t\u0000${part.text}`;
    case "thinking":
      return `h\u0000${part.thinking}`;
    case "toolCall":
      return `c\u0000${part.id}`;
    case "image":
      return "image";
    default:
      return "unknown";
  }
}

function messageKey(message: Message): string {
  const content = message.content;
  const text = typeof content === "string" ? content : content.map(contentPartKey).join("\u0000");
  return `${message.role}\u0000${text}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Deterministic, pure session key for pool stickiness: anchored on the system
 * prompt and the first message, which stay stable while a conversation appends
 * later turns.
 */
export function sessionIdFromContext(context: Context): string {
  const first = context.messages[0];
  const anchor = first === undefined ? "empty" : messageKey(first);
  return `cc-${fnv1a(`${context.systemPrompt ?? ""}\u0000${anchor}`)}`;
}

async function resolvePinnedAccount(
  options: FailoverStreamOptions,
  apiKey: string | undefined,
): Promise<PinnedAccount | undefined> {
  if (apiKey === undefined || apiKey.length === 0 || options.resolveAccountIdByToken === undefined) {
    return undefined;
  }
  const id = await options.resolveAccountIdByToken(apiKey);
  return id === undefined ? undefined : { id, token: apiKey };
}

function scheduleBillingRefresh(options: FailoverStreamOptions, apiKey: string): void {
  if (options.billingCache.get(apiKey) !== undefined) return;
  options.refreshBilling(apiKey);
}

export function createFailoverStream(options: FailoverStreamOptions): FailoverStreamSimple {
  const attemptOnce = async (
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
        // Hosts of authHeader providers inject a preset Authorization header
        // into callOptions; every attempt must carry the SELECTED account's
        // credential on the wire instead of the leaked host-pinned one.
        headers: { ...callOptions?.headers, Authorization: `Bearer ${token}` },
      });
      inner = result instanceof Promise ? await result : result;
    } catch (error) {
      return { kind: "failed-before-first-event", cause: failureFromThrown(error) };
    }
    let forwarded = false;
    try {
      for await (const event of inner) {
        if (!forwarded && event.type === "error") {
          return {
            kind: "failed-before-first-event",
            cause: failureFromAssistantMessage(event.error),
            replay: event,
          };
        }
        forwarded = true;
        outer.push(event);
      }
      return { kind: "completed" };
    } catch (error) {
      if (forwarded) {
        // Never replay: the consumer already observed events from this attempt.
        outer.push(errorMessageEvent(model, messageOf(error), options.now()));
        return { kind: "completed" };
      }
      return { kind: "failed-before-first-event", cause: failureFromThrown(error) };
    }
  };

  const drive = async (
    outer: AssistantMessageEventStream,
    model: Model<"anthropic-messages">,
    context: Context,
    callOptions: SimpleStreamOptions | undefined,
  ): Promise<void> => {
    try {
      const tried = new Set<string>();
      const sessionId = options.sessionIdFromContext(context, callOptions);
      let pinned = await resolvePinnedAccount(options, callOptions?.apiKey);
      for (;;) {
        let token: string;
        let accountId: string;
        if (pinned !== undefined) {
          const current = pinned;
          pinned = undefined; // pinned keys seed the rotation; later attempts come from the pool
          token = current.token;
          accountId = current.id;
        } else {
          const lease = await options.pool.next(options.now(), { sessionId, excluded: tried });
          token = lease.token;
          accountId = lease.id;
        }
        tried.add(accountId);

        const outcome = await attemptOnce(token, model, context, callOptions, outer);
        if (outcome.kind === "completed") {
          outer.end();
          return;
        }

        const decision = options.parseCooldown(cooldownInputOf(outcome.cause, options.now()));
        if (decision === null) {
          // Not a cooldown (auth error, bad request, abort, …): never retried.
          if (outcome.replay !== undefined) outer.push(outcome.replay);
          else outer.push(errorMessageEvent(model, outcome.cause.message, options.now()));
          outer.end();
          return;
        }

        await options.pool.quarantine(accountId, decision.retryAtMs ?? options.now() + DEFAULT_COOLDOWN_MS);
        scheduleBillingRefresh(options, token);
      }
    } catch (error) {
      outer.push(errorMessageEvent(model, messageOf(error), options.now()));
    }
  };

  return (model, context, callOptions) => {
    const outer = options.createEventStream();
    if (!isAnthropicMessagesModel(model)) {
      outer.push(
        errorMessageEvent(
          model,
          `Command Code transport requires an anthropic-messages model (received api "${model.api}")`,
          options.now(),
        ),
      );
      return outer;
    }
    void drive(outer, model, context, callOptions);
    return outer;
  };
}
