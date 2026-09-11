import { access, cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createJiti } from "jiti/static";

const SENPI_PACKAGE = "@code-yeongyu/senpi";
const API_BASE = "http://127.0.0.1:1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isSenpiRoot(path: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
    return isRecord(manifest) && manifest["name"] === SENPI_PACKAGE;
  } catch (_error: unknown) {
    return false;
  }
}

async function rootFromExecutable(): Promise<string | undefined> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    try {
      const executable = await realpath(join(directory, "senpi"));
      const root = resolve(dirname(executable), "..");
      if (await isSenpiRoot(root)) return root;
    } catch (_error: unknown) {
      // This PATH entry does not contain the host executable.
    }
  }
  return undefined;
}

async function findHostRoot(): Promise<string | undefined> {
  // SENPI_PACKAGE_ROOT is the documented fallback for nonstandard/global installs.
  const override = process.env["SENPI_PACKAGE_ROOT"];
  if (override !== undefined && await isSenpiRoot(override)) return resolve(override);
  const executableRoot = await rootFromExecutable();
  if (executableRoot !== undefined) return executableRoot;
  const bunGlobalRoot = join(homedir(), ".bun/install/global/node_modules", SENPI_PACKAGE);
  return await isSenpiRoot(bunGlobalRoot) ? bunGlobalRoot : undefined;
}

const hostRoot = await findHostRoot();
if (hostRoot === undefined) {
  console.log(
    "host-load-proof: SKIP (no installed senpi host; set SENPI_PACKAGE_ROOT to its package root)",
  );
  process.exit(0);
}

const piAiDist = join(hostRoot, "node_modules/@earendil-works/pi-ai/dist");
const entries = {
  compat: join(piAiDist, "compat.js"),
  oauth: join(piAiDist, "oauth.js"),
  providers: join(piAiDist, "providers/all.js"),
  senpi: join(hostRoot, "dist/index.js"),
};
try {
  await Promise.all(Object.values(entries).map((path) => access(path)));
} catch (error: unknown) {
  console.error(`host-load-proof: FAILED (host surface is incomplete: ${String(error)})`);
  process.exit(1);
}

const workspace = await mkdtemp(join(tmpdir(), "commandcode-host-load-proof-"));
const isolatedExtension = join(workspace, "extensions/commandcode");
const sourceExtension = resolve(
  process.env["COMMANDCODE_EXTENSION_ROOT"] ?? "extensions/commandcode",
);
await cp(sourceExtension, isolatedExtension, { recursive: true });
process.env["COMMANDCODE_API_BASE"] = API_BASE;
process.env["COMMANDCODE_ACCOUNTS_FILE"] = join(workspace, "accounts.json");

try {
  // Loading an isolated copy prevents this repo's dev dependency from resolving
  // unmapped deep imports that the extension host itself does not expose.
  const jiti = createJiti(join(workspace, "host-loader.js"), {
    moduleCache: false,
    // The bundled host permits only aliases/virtual modules, never native
    // package fallback from an extension's own installation directory.
    tryNative: false,
    alias: {
      "@earendil-works/pi-ai/providers/all": entries.providers,
      "@earendil-works/pi-ai/compat": entries.compat,
      "@earendil-works/pi-ai/oauth": entries.oauth,
      "@earendil-works/pi-ai": entries.compat,
      "@code-yeongyu/senpi": entries.senpi,
    },
  });
  const loaded = await jiti.import<unknown>(join(isolatedExtension, "index.ts"));
  const extension = isRecord(loaded) ? loaded["default"] : undefined;
  if (typeof extension !== "function") throw new Error("extension default export is not a function");

  const registrations: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  await extension({
    registerProvider(name: unknown, config: unknown): void {
      if (typeof name !== "string" || !isRecord(config)) throw new Error("invalid provider registration");
      registrations.push({ name, config });
    },
  });

  const problems: string[] = [];
  if (registrations.length !== 1) problems.push(`expected one provider, got ${registrations.length}`);
  const registration = registrations[0];
  if (registration === undefined) throw new Error(problems[0] ?? "provider was not registered");
  if (registration.name !== "commandcode") problems.push(`unexpected provider ${registration.name}`);
  if (typeof registration.config["streamSimple"] !== "function") problems.push("streamSimple is not a function");

  const models = registration.config["models"];
  let anthropic = 0;
  let openai = 0;
  if (!Array.isArray(models)) {
    problems.push("models is not an array");
  } else {
    for (const value of models) {
      if (!isRecord(value) || typeof value["id"] !== "string") {
        problems.push("invalid model entry");
        continue;
      }
      const claude = value["id"].toLowerCase().startsWith("claude");
      const expectedApi = claude ? "anthropic-messages" : "openai-completions";
      const expectedBase = claude ? `${API_BASE}/provider` : `${API_BASE}/provider/v1`;
      if (value["api"] !== expectedApi) problems.push(`bad api for ${value["id"]}`);
      if (value["baseUrl"] !== expectedBase) problems.push(`bad baseUrl for ${value["id"]}`);
      if (claude) anthropic += 1;
      else openai += 1;
    }
  }
  if (anthropic === 0 || openai === 0) problems.push("both model routes were not registered");
  if (problems.length > 0) throw new Error(problems.join("; "));

  console.log(
    `host-load-proof: PASS provider=${registration.name} registrations=${registrations.length} ` +
      `streamSimple=${typeof registration.config["streamSimple"]} ` +
      `anthropic=${anthropic} openai=${openai} host=${hostRoot}`,
  );
} catch (error: unknown) {
  console.error(`host-load-proof: FAILED (${error instanceof Error ? error.message : String(error)})`);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
