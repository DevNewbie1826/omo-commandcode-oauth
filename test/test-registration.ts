import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import commandcodeExtension, { type CommandCodeHost } from "../extensions/commandcode/index.js";

const originalFetch = globalThis.fetch;
const originalApiBase = process.env["COMMANDCODE_API_BASE"];
const originalAccountsFile = process.env["COMMANDCODE_ACCOUNTS_FILE"];
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalApiBase === undefined) delete process.env["COMMANDCODE_API_BASE"];
  else process.env["COMMANDCODE_API_BASE"] = originalApiBase;
  if (originalAccountsFile === undefined) delete process.env["COMMANDCODE_ACCOUNTS_FILE"];
  else process.env["COMMANDCODE_ACCOUNTS_FILE"] = originalAccountsFile;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function register(fetchImpl: typeof fetch): Promise<ProviderConfig> {
  const directory = await mkdtemp(join(tmpdir(), "commandcode-registration-"));
  directories.push(directory);
  process.env["COMMANDCODE_API_BASE"] = "https://gateway.test";
  process.env["COMMANDCODE_ACCOUNTS_FILE"] = join(directory, "accounts.json");
  globalThis.fetch = fetchImpl;
  let config: ProviderConfig | undefined;
  const host: CommandCodeHost = {
    registerProvider: (_name, registered) => { config = registered; },
  };
  await commandcodeExtension(host);
  if (config === undefined) throw new Error("Command Code provider was not registered");
  return config;
}

function expectRoutes(config: ProviderConfig, anthropicIds: readonly string[], openaiIds: readonly string[]): void {
  const models = config.models ?? [];
  expect(models.filter((model) => model.api === "anthropic-messages").map((model) => model.id))
    .toEqual(anthropicIds);
  expect(models.filter((model) => model.api === "openai-completions").map((model) => model.id))
    .toEqual(openaiIds);
  for (const model of models) {
    expect(model.baseUrl).toBe(model.api === "anthropic-messages"
      ? "https://gateway.test/provider"
      : "https://gateway.test/provider/v1");
  }
}

describe("provider model registration", () => {
  it("wires live Claude and non-Claude catalog entries to their respective APIs", async () => {
    const config = await register(() => Promise.resolve(new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1_000_000 },
        { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1", context_length: 1_000_000 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    expect(config.api).toBe("anthropic-messages");
    expect(config.baseUrl).toBe("https://gateway.test/provider");
    expectRoutes(config, ["claude-sonnet-5"], ["deepseek/deepseek-v4.1-flash"]);
  });

  it("wires every static fallback entry to its respective API", async () => {
    const config = await register(() => Promise.reject(new TypeError("offline")));

    expectRoutes(
      config,
      ["claude-sonnet-4-6"],
      ["gpt-5.5", "deepseek/deepseek-v4-flash", "zai-org/GLM-5.1"],
    );
  });
});
