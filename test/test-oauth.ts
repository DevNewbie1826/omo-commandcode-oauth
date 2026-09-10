import { createServer, type Server } from "node:http";
import type { OAuthAuthInfo, OAuthCredentials, OAuthDeviceCodeInfo, OAuthLoginCallbacks, OAuthPrompt, OAuthSelectPrompt } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  AUTH_START_PORT,
  closeServer,
  CommandCodeCallbackError,
  CommandCodeStateMismatchError,
  startAuthServer,
} from "../extensions/commandcode/auth-server.js";
import {
  CommandCodeInvalidKeyError,
  CommandCodeKeyValidationError,
  createLogin,
  credentialsFromApiKey,
  generateStateToken,
  getApiKey,
  refreshToken,
  sanitizeApiKey,
} from "../extensions/commandcode/oauth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPEN_SERVERS: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(OPEN_SERVERS.splice(0).map((server) => closeServer(server)));
});

function track(server: Server): void {
  OPEN_SERVERS.push(server);
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** Real HTTP GET against the loopback callback server, mirroring the browser redirect. */
function callbackGet(port: number, query: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(query).toString()}`, {
    keepalive: false,
  });
}

function whoamiResponse(status: number, body: unknown = { user: { id: "u-1", userName: "tester" } }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function whoamiFetch(response: Response): Mock<typeof fetch> {
  return vi.fn<typeof fetch>(async () => response);
}

function onCredentialSpy(): Mock<(apiKey: string) => void> {
  return vi.fn<(apiKey: string) => void>();
}

function loginCallbacks(overrides: Partial<OAuthLoginCallbacks> = {}): OAuthLoginCallbacks {
  return {
    onAuth: vi.fn<(info: OAuthAuthInfo) => void>(),
    onDeviceCode: vi.fn<(info: OAuthDeviceCodeInfo) => void>(),
    onPrompt: vi.fn<(prompt: OAuthPrompt) => Promise<string>>(async () => ""),
    onSelect: vi.fn<(prompt: OAuthSelectPrompt) => Promise<string | undefined>>(async () => undefined),
    ...overrides,
  };
}

function onPromptReturning(key: string): Mock<(prompt: OAuthPrompt) => Promise<string>> {
  return vi.fn<(prompt: OAuthPrompt) => Promise<string>>(async () => key);
}

/** onAuth double that resolves exactly when the host hands out the browser URL (no polling). */
function onAuthSignal(): { onAuth: OAuthLoginCallbacks["onAuth"]; url: Promise<string> } {
  let resolveUrl!: (url: string) => void;
  const url = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const onAuth: OAuthLoginCallbacks["onAuth"] = vi.fn((info: OAuthAuthInfo) => resolveUrl(info.url));
  return { onAuth, url };
}

function assertInstance<T extends Error>(value: unknown, ctor: new (...args: never[]) => T): T {
  if (!(value instanceof ctor)) throw new Error(`Expected a ${ctor.name}, got: ${String(value)}`);
  return value;
}

// ---------------------------------------------------------------------------
// auth-server
// ---------------------------------------------------------------------------

describe("startAuthServer", () => {
  test("Given a matching callback GET, When the browser requests /callback, Then it responds 200 with the landing page and waitForCallback resolves the parsed payload", async () => {
    const { server, port, waitForCallback } = await startAuthServer({
      expectedState: "state-expected",
      landingGraceMs: 5,
    });
    track(server);
    const closed = new Promise<void>((resolve) => server.once("close", resolve));

    const response = await callbackGet(port, {
      apiKey: "k",
      state: "state-expected",
      userId: "u",
      userName: "n",
      keyName: "cli",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Authentication complete");
    await expect(waitForCallback).resolves.toEqual({
      apiKey: "k",
      state: "state-expected",
      userId: "u",
      userName: "n",
      keyName: "cli",
    });
    await closed;
    expect(server.listening).toBe(false);
  });

  test("Given a callback with a mismatched state, When the browser requests /callback, Then the server responds 403 and waitForCallback rejects", async () => {
    const { server, port, waitForCallback } = await startAuthServer({ expectedState: "state-expected" });
    track(server);
    const rejected = waitForCallback.then(
      () => {
        throw new Error("waitForCallback resolved on a mismatched state");
      },
      (error: unknown) => error,
    );

    const response = await callbackGet(port, {
      apiKey: "k",
      state: "state-evil",
      userId: "u",
      userName: "n",
      keyName: "cli",
    });

    expect(response.status).toBe(403);
    expect(await rejected).toBeInstanceOf(CommandCodeStateMismatchError);
  });

  test("Given an OAuth error callback with the matching state, When the browser reports the denial, Then waitForCallback rejects with the error description", async () => {
    const { server, port, waitForCallback } = await startAuthServer({ expectedState: "state-expected" });
    track(server);
    const rejected = waitForCallback.then(
      () => {
        throw new Error("waitForCallback resolved on an error callback");
      },
      (error: unknown) => error,
    );

    const response = await callbackGet(port, {
      error: "access_denied",
      error_description: "denied",
      state: "state-expected",
    });

    expect(response.status).toBe(200);
    const callbackError = assertInstance(await rejected, CommandCodeCallbackError);
    expect(callbackError.message).toContain("denied");
  });

  test("Given the start port already occupied, When the auth server starts, Then it binds the next consecutive port", async () => {
    const blocker = createServer();
    track(blocker);
    await listenOn(blocker, AUTH_START_PORT);

    const { server, port } = await startAuthServer({ expectedState: "state-expected" });
    track(server);

    expect(port).toBe(AUTH_START_PORT + 1);
    expect(server.listening).toBe(true);
  });

  test("Given an oversized callback URL, When it arrives, Then the server responds 414", async () => {
    const { server, port } = await startAuthServer({ expectedState: "state-expected" });
    track(server);

    const response = await fetch(`http://127.0.0.1:${port}/callback?fill=${"a".repeat(9000)}`, {
      keepalive: false,
    });

    expect(response.status).toBe(414);
  });
});

// ---------------------------------------------------------------------------
// oauth primitives
// ---------------------------------------------------------------------------

describe("generateStateToken", () => {
  test("Given two generated tokens, When compared, Then both are 43-char base64url and distinct", () => {
    const first = generateStateToken();
    const second = generateStateToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });
});

describe("sanitizeApiKey", () => {
  test("Given an ESC-bracketed-paste wrapped key, When sanitized, Then the wrappers are removed", () => {
    expect(sanitizeApiKey("\x1b[200~sk-abc\x1b[201~")).toBe("sk-abc");
  });

  test("Given a literal bracketed-paste wrapped key, When sanitized, Then the wrappers are removed", () => {
    expect(sanitizeApiKey("[200~sk-abc[201~")).toBe("sk-abc");
  });

  test("Given a key containing control characters, When sanitized, Then control characters are stripped", () => {
    expect(sanitizeApiKey("sk\r\n-abc\x07")).toBe("sk-abc");
  });

  test("Given a clean padded key, When sanitized, Then only surrounding whitespace is trimmed", () => {
    expect(sanitizeApiKey("  sk-abc  ")).toBe("sk-abc");
  });
});

describe("credentialsFromApiKey", () => {
  test("Given an API key and an injected clock, When credentials are built, Then access and refresh carry the key with a ten-year expiry", () => {
    const now = (): number => 1_000;
    const credentials = credentialsFromApiKey("cc-key", now);

    expect(credentials).toEqual({
      access: "cc-key",
      refresh: "cc-key",
      expires: 1_000 + 10 * 365 * 24 * 60 * 60 * 1000,
    });
  });
});

describe("refreshToken", () => {
  test("Given stored credentials, When refreshed, Then they come back unchanged because Command Code keys never expire", async () => {
    const credentials = credentialsFromApiKey("cc-key");

    await expect(refreshToken(credentials)).resolves.toBe(credentials);
  });
});

describe("getApiKey", () => {
  test("Given stored credentials, When the host asks for the API key, Then the access token is returned", () => {
    expect(getApiKey(credentialsFromApiKey("cc-key"))).toBe("cc-key");
  });
});

// ---------------------------------------------------------------------------
// createLogin
// ---------------------------------------------------------------------------

describe("createLogin happy path", () => {
  test("Given the studio hands the key back through the loopback callback, When login runs, Then the browser URL is offered, the key is validated via whoami, and credentials are issued", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => whoamiResponse(200));
    const onCredential = onCredentialSpy();
    const login = createLogin({ fetchFn, onCredential });
    const { onAuth, url: authUrlPromise } = onAuthSignal();
    const callbacks = loginCallbacks({ onAuth });

    const pending = login(callbacks);
    const authUrl = await authUrlPromise;
    const parsed = new URL(authUrl);
    expect(parsed.pathname).toBe("/studio/auth/cli");
    expect(authUrl).toContain("callback=");
    expect(authUrl).toContain("state=");
    expect(authUrl).toContain("mode=redirect");
    expect(parsed.searchParams.get("mode")).toBe("redirect");
    expect(parsed.searchParams.get("callback")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const state = parsed.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const callbackUrl = parsed.searchParams.get("callback") ?? "";
    const response = await callbackGet(Number(new URL(callbackUrl).port), {
      apiKey: "k",
      state,
      userId: "u",
      userName: "n",
      keyName: "cli",
    });
    expect(response.status).toBe(200);

    const credentials: OAuthCredentials = await pending;
    expect(credentials).toEqual({ access: "k", refresh: "k", expires: expect.any(Number) });
    expect(credentials.expires).toBeGreaterThan(Date.now());

    const whoamiCall = fetchFn.mock.calls[0];
    expect(String(whoamiCall?.[0])).toBe("https://api.commandcode.ai/alpha/whoami");
    expect(new Headers(whoamiCall?.[1]?.headers).get("authorization")).toBe("Bearer k");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(onCredential).toHaveBeenCalledWith("k");
    expect(callbacks.onPrompt).not.toHaveBeenCalled();
  });
});

describe("createLogin paste fallback", () => {
  test("Given the browser never calls back within COMMANDCODE_AUTH_TIMEOUT_MS, When login runs, Then it falls back to the paste prompt and issues credentials for the pasted key", async () => {
    vi.stubEnv("COMMANDCODE_AUTH_TIMEOUT_MS", "50");
    const fetchFn = whoamiFetch(whoamiResponse(200));
    const onCredential = onCredentialSpy();
    const login = createLogin({ fetchFn, onCredential });
    const onPrompt = onPromptReturning("user_pasted");
    const callbacks = loginCallbacks({ onPrompt });

    const credentials = await login(callbacks);

    expect(credentials.access).toBe("user_pasted");
    expect(credentials.refresh).toBe("user_pasted");
    expect(credentials.expires).toBeGreaterThan(Date.now());
    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(onCredential).toHaveBeenCalledWith("user_pasted");
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("createLogin credential persistence", () => {
  test("Given the onCredential hook rejects, When login runs, Then login awaits the hook and fails with the persistence error instead of issuing credentials", async () => {
    vi.stubEnv("COMMANDCODE_AUTH_TIMEOUT_MS", "50");
    const fetchFn = whoamiFetch(whoamiResponse(200));
    const onCredential = vi.fn<(apiKey: string) => Promise<void>>(async () => {
      throw new Error("accounts file is not writable");
    });
    const login = createLogin({ fetchFn, onCredential });
    const callbacks = loginCallbacks({ onPrompt: onPromptReturning("pasted-key") });

    let failure: unknown;
    let credentials: OAuthCredentials | undefined;
    try {
      credentials = await login(callbacks);
    } catch (error) {
      failure = error;
    }

    expect(onCredential).toHaveBeenCalledTimes(1);
    expect(onCredential).toHaveBeenCalledWith("pasted-key");
    expect(credentials).toBeUndefined();
    expect(assertInstance(failure, Error).message).toContain("accounts file is not writable");
  });
});

describe("createLogin key validation", () => {
  test("Given a pasted key the upstream rejects with 401, When login runs, Then it rejects with the non-retryable invalid-key error", async () => {
    vi.stubEnv("COMMANDCODE_AUTH_TIMEOUT_MS", "50");
    const login = createLogin({ fetchFn: whoamiFetch(whoamiResponse(401, { error: "invalid api key" })) });
    const callbacks = loginCallbacks({ onPrompt: onPromptReturning("bad-key") });

    let failure: unknown;
    try {
      await login(callbacks);
    } catch (error) {
      failure = error;
    }

    const invalid = assertInstance(failure, CommandCodeInvalidKeyError);
    expect(invalid.retryable).toBe(false);
  });

  test("Given the upstream answers 500, When login validates the pasted key, Then it rejects with a retryable validation error", async () => {
    vi.stubEnv("COMMANDCODE_AUTH_TIMEOUT_MS", "50");
    const login = createLogin({ fetchFn: whoamiFetch(whoamiResponse(500, { error: "boom" })) });
    const callbacks = loginCallbacks({ onPrompt: onPromptReturning("some-key") });

    let failure: unknown;
    try {
      await login(callbacks);
    } catch (error) {
      failure = error;
    }

    const validation = assertInstance(failure, CommandCodeKeyValidationError);
    expect(validation.retryable).toBe(true);
  });

  test("Given the upstream is unreachable, When login validates the pasted key, Then it rejects with a retryable validation error", async () => {
    vi.stubEnv("COMMANDCODE_AUTH_TIMEOUT_MS", "50");
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("connection refused");
    });
    const login = createLogin({ fetchFn });
    const callbacks = loginCallbacks({ onPrompt: onPromptReturning("some-key") });

    let failure: unknown;
    try {
      await login(callbacks);
    } catch (error) {
      failure = error;
    }

    const validation = assertInstance(failure, CommandCodeKeyValidationError);
    expect(validation.retryable).toBe(true);
  });
});
