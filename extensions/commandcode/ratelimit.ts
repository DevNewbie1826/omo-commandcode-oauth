export type FailureClass = "rotatable" | "propagate";

export interface ClassifyFailureInput {
  readonly status?: number;
  readonly body?: unknown;
  readonly message?: string;
  readonly network?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch (_error: unknown) {
    return body;
  }
}

function containsRateLimit(value: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (typeof value === "string") {
    return /(?:RATE_LIMITED|rate_limit_error)/i.test(value);
  }
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => containsRateLimit(entry, depth + 1));
}

export function classifyFailure(input: ClassifyFailureInput): FailureClass {
  if (input.status === 401 || input.status === 403) return "propagate";
  if (input.status === 429 || (input.status !== undefined && input.status >= 500)) {
    return "rotatable";
  }
  if (containsRateLimit(parsedBody(input.body)) || containsRateLimit(input.message)) {
    return "rotatable";
  }
  return input.network === true ? "rotatable" : "propagate";
}
