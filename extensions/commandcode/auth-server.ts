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

  const callbackHandlers: {
    resolve: ((payload: AuthCallbackPayload) => void) | undefined;
    reject: ((error: Error) => void) | undefined;
  } = { resolve: undefined, reject: undefined };
  const waitForCallback = new Promise<AuthCallbackPayload>((resolve, reject) => {
    callbackHandlers.resolve = resolve;
    callbackHandlers.reject = reject;
  });

  const resolveCallback = (payload: AuthCallbackPayload): void => {
    const resolve = callbackHandlers.resolve;
    if (resolve === undefined) throw new CommandCodeAuthError("Callback promise resolver was not initialized");
    resolve(payload);
  };
  const rejectCallback = (error: Error): void => {
    const reject = callbackHandlers.reject;
    if (reject === undefined) throw new CommandCodeAuthError("Callback promise rejecter was not initialized");
    reject(error);
  };

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
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("Method not allowed");
      return;
    }
    if (settled) {
      response.writeHead(409);
      response.end("Authentication already handled");
      return;
    }

    const query = parsed.searchParams;
    const state = queryValue(query, "state") ?? "";
    if (state !== expectedState) {
      response.writeHead(403);
      response.end("Invalid state parameter", () => {
        settleReject(
          new CommandCodeStateMismatchError("Command Code callback state did not match the pending login"),
        );
      });
      return;
    }

    const errorCode = queryValue(query, "error");
    if (errorCode !== undefined) {
      const description = queryValue(query, "error_description") ?? errorCode;
      response.writeHead(200, HTML_HEADERS);
      response.end(errorPage(description), () => {
        settleReject(new CommandCodeCallbackError(`Command Code authorization failed: ${description}`));
      });
      return;
    }

    const apiKey = queryValue(query, "apiKey");
    const userId = queryValue(query, "userId");
    const userName = queryValue(query, "userName");
    const keyName = queryValue(query, "keyName");
    if (apiKey === undefined || userId === undefined || userName === undefined || keyName === undefined) {
      response.writeHead(400);
      response.end("Missing required callback parameters");
      return;
    }

    response.writeHead(200, HTML_HEADERS);
    response.end(SUCCESS_PAGE, () => {
      settleResolve({ apiKey, state, userId, userName, keyName });
    });
  });

  return { server, port, waitForCallback };
}
