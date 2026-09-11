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
if (captured === undefined) {
  problems.push("no provider was registered");
} else {
  if (captured.name !== "commandcode") problems.push(`unexpected provider name "${captured.name}"`);
  if (captured.config.api !== "anthropic-messages") problems.push(`unexpected api "${String(captured.config.api)}"`);
  if (typeof captured.config.oauth?.login !== "function") problems.push("oauth.login is not a function");
  if ((captured.config.models?.length ?? 0) === 0) problems.push("model catalog is empty");
}

await rm(workspace, { recursive: true, force: true });

if (captured === undefined || problems.length > 0) {
  console.error(`load-proof: FAILED (${problems.join("; ")})`);
  process.exitCode = 1;
} else {
  console.log(
    `load-proof: provider "${captured.name}" registered (api=${captured.config.api}, ` +
      `models=${captured.config.models?.length ?? 0}, ` +
      `oauth.login=${typeof captured.config.oauth?.login}, ` +
      `baseUrl=${captured.config.baseUrl})`,
  );
}
