import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import type { CommandCodeHost } from "../extensions/commandcode/index.js";

interface RegisteredProvider {
  readonly name: string;
  readonly config: ProviderConfig;
}

const workspace = await mkdtemp(join(tmpdir(), "commandcode-load-proof-"));
// Force model loading through the static fallback without network access.
process.env["COMMANDCODE_API_BASE"] = "http://127.0.0.1:1";
process.env["COMMANDCODE_ACCOUNTS_FILE"] = join(workspace, "accounts.json");

const { default: commandcodeExtension } = await import("../extensions/commandcode/index.js");

let registered: RegisteredProvider | undefined;
const host: CommandCodeHost = {
  registerProvider(name, config) {
    registered = { name, config };
  },
};

await commandcodeExtension(host);
const captured: RegisteredProvider | undefined = registered;

const problems: string[] = [];
let anthropicModels = 0;
let openaiModels = 0;
if (captured === undefined) {
  problems.push("no provider was registered");
} else {
  if (captured.name !== "commandcode") problems.push(`unexpected provider name "${captured.name}"`);
  if (captured.config.api !== "anthropic-messages") problems.push(`unexpected api "${String(captured.config.api)}"`);
  if (typeof captured.config.oauth?.login !== "function") problems.push("oauth.login is not a function");
  if ((captured.config.models?.length ?? 0) === 0) problems.push("model catalog is empty");
  for (const model of captured.config.models ?? []) {
    if (model.api === "anthropic-messages") {
      anthropicModels += 1;
      if (model.baseUrl !== "http://127.0.0.1:1/provider") problems.push(`bad Anthropic baseUrl for ${model.id}`);
    } else if (model.api === "openai-completions") {
      openaiModels += 1;
      if (model.baseUrl !== "http://127.0.0.1:1/provider/v1") problems.push(`bad OpenAI baseUrl for ${model.id}`);
    } else {
      problems.push(`unexpected model api "${String(model.api)}" for ${model.id}`);
    }
  }
  if (anthropicModels === 0 || openaiModels === 0) problems.push("both model routes were not registered");
}

await rm(workspace, { recursive: true, force: true });

if (captured === undefined || problems.length > 0) {
  console.error(`load-proof: FAILED (${problems.join("; ")})`);
  process.exitCode = 1;
} else {
  console.log(
    `load-proof: provider "${captured.name}" registered (api=${captured.config.api}, ` +
      `models=${captured.config.models?.length ?? 0}, ` +
      `anthropic=${anthropicModels}, openai=${openaiModels}, ` +
      `oauth.login=${typeof captured.config.oauth?.login}, ` +
      `baseUrl=${captured.config.baseUrl})`,
  );
}
