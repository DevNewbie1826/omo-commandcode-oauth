import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const AUTH_START_PORT = 5959;
export const AUTH_PORT_ATTEMPTS = 10;
export const AUTH_LANDING_GRACE_MS = 500;

const CALLBACK_PATH = "/callback";
const MAX_CALLBACK_URL_LENGTH = 8192;
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;
const SUCCESS_PAGE =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Command Code</title></head><body><h1>Authentication complete</h1><p>You can close this window and return to the terminal.</p></body></html>";

export class CommandCodeAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeAuthError";
  }
}

export class CommandCodePortError extends CommandCodeAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodePortError";
  }
}

export class CommandCodeStateMismatchError extends CommandCodeAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeStateMismatchError";
  }
}

export class CommandCodeCallbackError extends CommandCodeAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandCodeCallbackError";
  }
}

export type AuthCallbackPayload = {
  readonly apiKey: string;
  readonly state: string;
  readonly userId: string;
  readonly userName: string;
  readonly keyName: string;
};

/** Studio origins allowed to deliver credentials cross-origin (official CLI allowlist). */
const ALLOWED_ORIGINS = new Set([
  "https://commandcode.ai",
  "https://staging.commandcode.ai",
  "http://localhost:3000",
]);

const ALLOWED_METHODS = "GET, POST, OPTIONS";

/** Callback payloads are tiny; refuse to buffer arbitrarily large credential posts. */
const MAX_BODY_BYTES = 8192;

function corsHeaders(origin: string | null): Readonly<Record<string, string>> {
  const allowed = origin !== null && ALLOWED_ORIGINS.has(origin) ? origin : "https://commandcode.ai";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

interface CallbackParams {
  readonly apiKey: string | null;
  readonly state: string | null;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly keyName: string | null;
  readonly error: string | undefined;
  readonly error_description: string | undefined;
}

function paramsFromQuery(query: URLSearchParams): CallbackParams {
  return {
    apiKey: query.get("apiKey"),
    state: query.get("state"),
    userId: query.get("userId"),
    userName: query.get("userName"),
    keyName: query.get("keyName"),
    error: query.get("error") ?? undefined,
    error_description: query.get("error_description") ?? undefined,
  };
}

async function paramsFromBody(request: IncomingMessage): Promise<CallbackParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const pick = (key: string): string | null => (typeof record[key] === "string" ? record[key] : null);
  return {
    apiKey: pick("apiKey"),
    state: pick("state"),
    userId: pick("userId"),
    userName: pick("userName"),
    keyName: pick("keyName"),
    error: pick("error") ?? undefined,
    error_description: pick("error_description") ?? undefined,
  };
}

export type AuthServerHandle = {
  readonly server: Server;
  readonly port: number;
  readonly waitForCallback: Promise<AuthCallbackPayload>;
};

export type StartAuthServerOptions = {
  readonly expectedState: string;
  readonly startPort?: number;
  readonly portAttempts?: number;
  readonly landingGraceMs?: number;
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function errorPage(description: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Command Code</title></head><body><h1>Authentication failed</h1><p>${escapeHtml(description)}</p></body></html>`;
}

function queryValue(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  if (value === null || value.length === 0) return undefined;
  return value;
}

function listenOnPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}

async function bindFirstAvailable(startPort: number, attempts: number): Promise<Server> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await listenOnPort(startPort + attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw new CommandCodePortError(
    `No available Command Code callback port after ${attempts} attempts starting at ${startPort}`,
    { cause: lastError },
  );
}

/** Idempotent: closing an already-closed server resolves instead of failing cleanup. */
export async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export async function startAuthServer(options: StartAuthServerOptions): Promise<AuthServerHandle> {
  const expectedState = options.expectedState;
  if (expectedState.length === 0) {
    throw new CommandCodeAuthError("startAuthServer requires a non-empty expectedState");
  }
  const startPort = options.startPort ?? AUTH_START_PORT;
  const portAttempts = options.portAttempts ?? AUTH_PORT_ATTEMPTS;
  const landingGraceMs = options.landingGraceMs ?? AUTH_LANDING_GRACE_MS;

  const server = await bindFirstAvailable(startPort, portAttempts);
  server.maxRequestsPerSocket = 1;
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new CommandCodeAuthError("Command Code auth server bound without a TCP address");
  }
  const port = address.port;

  let resolveCallback!: (payload: AuthCallbackPayload) => void;
  let rejectCallback!: (error: Error) => void;
  const waitForCallback = new Promise<AuthCallbackPayload>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  let settled = false;
  const settleReject = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectCallback(error);
  };
  const settleResolve = (payload: AuthCallbackPayload): void => {
    if (settled) return;
    settled = true;
    resolveCallback(payload);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void closeServer(server);
    }, landingGraceMs);
    timer.unref();
  };

  server.on("request", (request: IncomingMessage, response: ServerResponse): void => {
    const rawUrl = request.url ?? "/";
    if (rawUrl.length > MAX_CALLBACK_URL_LENGTH) {
      response.writeHead(414);
      response.end("URI too long");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl, `http://127.0.0.1:${port}`);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }

    if (parsed.pathname !== CALLBACK_PATH) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const originHeader = typeof request.headers.origin === "string" ? request.headers.origin : null;

    const cors = corsHeaders(originHeader);

    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "POST") {
      response.writeHead(405, { Allow: ALLOWED_METHODS });
      response.end("Method not allowed");
      return;
    }
    if (settled) {
      response.writeHead(409);
      response.end("Authentication already handled");
      return;
    }

    const query = parsed.searchParams;

    const bodyReady = new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_BODY_BYTES) {
          request.destroy();
          resolve("");
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", () => resolve(""));
    });

    const respondPage = (status: number, body: string, onDone: () => void): void => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...cors });
      response.end(body, onDone);
    };

    void (async () => {
      const capturedBody = await bodyReady;
      let params: CallbackParams = paramsFromQuery(query);
      if (request.method === "POST" && capturedBody !== "") {
        const contentType = String(request.headers["content-type"] ?? "");
        const pickFrom = (get: (key: string) => string | null) => ({
          apiKey: get("apiKey"),
          state: get("state"),
          userId: get("userId"),
          userName: get("userName"),
          keyName: get("keyName"),
          error: get("error") ?? undefined,
          error_description: get("error_description") ?? undefined,
        });
        if (contentType.includes("application/x-www-form-urlencoded")) {
          const form = new URLSearchParams(capturedBody);
          params = pickFrom((key) => form.get(key));
        } else {
          try {
            const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
            params = pickFrom((key) => (typeof parsed[key] === "string" ? parsed[key] : null));
          } catch {}
        }
      }

      const errorCode = params.error ?? queryValue(query, "error") ?? undefined;
      if (errorCode !== null && errorCode !== undefined) {
        const description = queryValue(query, "error_description") ?? errorCode;
        respondPage(200, errorPage(description), () => {
          settleReject(new CommandCodeCallbackError(`Command Code authorization failed: ${description}`));
        });
        return;
      }

      const apiKey = params.apiKey;
      const userId = params.userId;
      const userName = params.userName;
      const keyName = params.keyName;
      const payloadState = params.state ?? "";
      if (apiKey === null || userId === null || userName === null || keyName === null || payloadState === "") {
        respondPage(400, "Missing required callback parameters", () => {});
        return;
      }
      if (payloadState !== expectedState) {
        respondPage(403, "Invalid state parameter", () => {
          settleReject(new CommandCodeStateMismatchError("Command Code callback state did not match the pending login"));
        });
        return;
      }

      respondPage(200, SUCCESS_PAGE, () => {
        settleResolve({ apiKey, state: payloadState, userId, userName, keyName });
      });
    })();
  });

  return { server, port, waitForCallback };
}
