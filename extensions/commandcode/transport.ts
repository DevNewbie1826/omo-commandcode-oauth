/**
 * Failover transport for the Command Code provider.
 *
 * Wraps the pi-ai anthropic-messages `streamSimple` so that a request which
 * is rate-limited or out of credits — BEFORE its first forwarded event or
 * AFTER output already flowed — quarantines the dead account (cooldown parsed
 * via `parseCooldown`, sessions unbound) for FUTURE requests, while the
 * current request is never retried or replayed: a pre-output failure rotates
 * to the next account of the shared pool (each account at most once per
 * request), a post-output failure is propagated as-is after the quarantine
 * lands, so the next request cannot pick the same dead account again.
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

/**
 * Canonical retry hint the pi-ai adapter appends to folded 429 failure
 * messages — `… (retry-after-ms: <ms>)`, mirroring `appendRetryAfterMsMarker`
 * in pi-ai's `utils/retry-hint`. The value is bounded like `parseCooldown`'s
 * own timestamps: finite, positive, at most the max valid Date epoch ms.
 */
const RETRY_AFTER_MS_MARKER = /\(retry-after-ms: (\d+)\)$/;
const MAX_RETRY_HINT_MS = 8.64e15;

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
   * Maps an explicit `options.apiKey` to a pool account id. Implementations
   * must only return ids of accounts fit to attempt (enabled, cooldown lapsed);
   * when provided and the key resolves, that id is passed to `pool.next` as
   * `preferredId` — a weakest-signal tiebreaker that sorts first within tier 1
   * only, AFTER healthy sticky bindings and all tier-0 candidates. An
   * unhealthy, absent, or already-tried pin falls through to normal selection.
   */
  readonly resolveAccountIdByToken?: (token: string) => Promise<string | undefined>;
}

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
    }
  | {
      readonly kind: "failed-after-first-event";
      readonly cause: FailureCause;
      /** Terminal error event the consumer must still observe; re-emitted after quarantine. */
      readonly surfaced?: AssistantMessageEvent;
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

/**
 * Recover the adapter's retry hint from a folded failure message and express it
 * as a Retry-After delta-seconds string. The adapter marker carries whole
 * milliseconds; ceiling keeps the quarantine at or above what upstream asked
 * for, and `parseCooldown`'s `toRetryAtMs` bound re-validates the result.
 */
function retryAfterHintSeconds(message: string): string | undefined {
  const match = RETRY_AFTER_MS_MARKER.exec(message);
  if (match === null) return undefined;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_RETRY_HINT_MS) return undefined;
  return String(Math.ceil(ms / 1000));
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
  const headers = headersFrom(cause.headers);
  const retryAfterHint = retryAfterHintSeconds(cause.message);
  return {
    status: cause.status ?? statusFromMessage(cause.message) ?? 0,
    body: cooldownBodyOf(cause),
    // The adapter's retry-after-ms marker is the wire's Retry-After equivalent;
    // injected as a header hint it lands in parseCooldown's documented tier —
    // after a body rateLimit.reset and a message "resets at" ISO, and ahead of
    // any literal Retry-After header within that tier.
    headers:
      retryAfterHint === undefined
        ? headers
        : { ...headers, "retry-after": retryAfterHint },
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

async function resolvePinnedAccountId(
  options: FailoverStreamOptions,
  apiKey: string | undefined,
): Promise<string | undefined> {
  if (apiKey === undefined || apiKey.length === 0 || options.resolveAccountIdByToken === undefined) {
    return undefined;
  }
  return options.resolveAccountIdByToken(apiKey);
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
        if (event.type === "error") {
          const cause = failureFromAssistantMessage(event.error);
          if (!forwarded) {
            return { kind: "failed-before-first-event", cause, replay: event };
          }
          return { kind: "failed-after-first-event", cause, surfaced: event };
        }
        forwarded = true;
        outer.push(event);
      }
      return { kind: "completed" };
    } catch (error) {
      if (forwarded) {
        // Never replay: the consumer already observed events from this attempt.
        return { kind: "failed-after-first-event", cause: failureFromThrown(error) };
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
      const pinnedId = await resolvePinnedAccountId(options, callOptions?.apiKey);
      for (;;) {
        // The pin rides inside normal selection as `preferredId`: a healthy
        // sticky binding or tier-0 candidate still wins, and once the pinned
        // account is tried (or quarantined mid-request) `excluded` neuters it.
        const lease = await options.pool.next(options.now(), {
          sessionId,
          excluded: tried,
          ...(pinnedId === undefined ? {} : { preferredId: pinnedId }),
        });
        tried.add(lease.id);

        const outcome = await attemptOnce(lease.token, model, context, callOptions, outer);
        if (outcome.kind === "completed") {
          outer.end();
          return;
        }

        const decision = options.parseCooldown(cooldownInputOf(outcome.cause, options.now()));
        if (outcome.kind === "failed-after-first-event") {
          // Terminal failure after the consumer saw output: quarantine the dead
          // account for FUTURE requests when it is a cooldown, but never retry
          // or replay the current one — propagate and stop.
          if (decision !== null) {
            await options.pool.quarantine(
              lease.id,
              decision.retryAtMs ?? options.now() + DEFAULT_COOLDOWN_MS,
            );
            scheduleBillingRefresh(options, lease.token);
          }
          if (outcome.surfaced !== undefined) outer.push(outcome.surfaced);
          else outer.push(errorMessageEvent(model, outcome.cause.message, options.now()));
          outer.end();
          return;
        }
        if (decision === null) {
          // Not a cooldown (auth error, bad request, abort, …): never retried.
          if (outcome.replay !== undefined) outer.push(outcome.replay);
          else outer.push(errorMessageEvent(model, outcome.cause.message, options.now()));
          outer.end();
          return;
        }

        await options.pool.quarantine(lease.id, decision.retryAtMs ?? options.now() + DEFAULT_COOLDOWN_MS);
        scheduleBillingRefresh(options, lease.token);
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
