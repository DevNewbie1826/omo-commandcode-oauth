import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { CommandCodeApi } from "../extensions/commandcode/models.js";
import type { CommandCodeHost } from "../extensions/commandcode/index.js";

export interface RealRequest {
  readonly account: string;
  readonly path: string;
  destroy(): void;
  respond(status: number, body: string, headers?: Readonly<Record<string, string>>): void;
}

export interface RealAdapterHarness {
  readonly attempts: string[];
  readonly paths: string[];
  request(options?: SimpleStreamOptions): Promise<readonly AssistantMessageEvent[]>;
  close(): Promise<void>;
}

export async function bootRealAdapter(
  handleMessage: (request: RealRequest) => void,
  api: CommandCodeApi = "anthropic-messages",
): Promise<RealAdapterHarness> {
  const id = api === "anthropic-messages" ? "claude-sonnet-4-6" : "gpt-5.5";
  const catalog = JSON.stringify({
    object: "list",
    data: [{ id, name: id, context_length: 200000 }],
  });
  const attempts: string[] = [];
  const paths: string[] = [];
  const expectedPath = api === "anthropic-messages"
    ? "/provider/v1/messages"
    : "/provider/v1/chat/completions";
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/provider/v1/models") {
      response.writeHead(200, { "content-type": "application/json" }).end(catalog);
      return;
    }
    if (path !== expectedPath) {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const account = request.headers.authorization === "Bearer token-a1" ? "a1" : "a2";
    attempts.push(account);
    paths.push(path);
    handleMessage({
      account,
      path,
      destroy: () => request.socket.destroy(),
      respond: (status, body, headers = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers }).end(body);
      },
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback server has no port");
  const directory = await mkdtemp(join(tmpdir(), "commandcode-real-adapter-"));
  const accountsPath = join(directory, "accounts.json");
  await writeFile(accountsPath, JSON.stringify({
    version: 1,
    accounts: ["a1", "a2"].map((id) => ({
      id,
      token: `token-${id}`,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
  }));
  const base = `http://127.0.0.1:${address.port}`;
  const previousBase = process.env.COMMANDCODE_API_BASE;
  const previousAccounts = process.env.COMMANDCODE_ACCOUNTS_FILE;
  process.env.COMMANDCODE_API_BASE = base;
  process.env.COMMANDCODE_ACCOUNTS_FILE = accountsPath;
  const { default: extension } = await import("../extensions/commandcode/index.js");
  let config: ProviderConfig | undefined;
  const host: CommandCodeHost = { registerProvider: (_name, value) => { config = value; } };
  await extension(host);
  if (config?.streamSimple === undefined) throw new Error("Real adapter stream was not registered");
  const streamSimple = config.streamSimple;
  const model: Model<Api> = {
    id,
    name: id,
    api,
    provider: "commandcode",
    baseUrl: api === "anthropic-messages" ? `${base}/provider` : `${base}/provider/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 65536,
  };
  const context: Context = { messages: [] };
  return {
    attempts,
    paths,
    async request(options) {
      const events: AssistantMessageEvent[] = [];
      for await (const event of streamSimple(model, context, options)) events.push(event);
      return events;
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
      if (previousBase === undefined) delete process.env.COMMANDCODE_API_BASE;
      else process.env.COMMANDCODE_API_BASE = previousBase;
      if (previousAccounts === undefined) delete process.env.COMMANDCODE_ACCOUNTS_FILE;
      else process.env.COMMANDCODE_ACCOUNTS_FILE = previousAccounts;
    },
  };
}
