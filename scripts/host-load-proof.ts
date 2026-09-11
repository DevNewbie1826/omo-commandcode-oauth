import { access, cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createJiti } from "jiti/static";

const SENPI_PACKAGE = "@code-yeongyu/senpi";
const API_BASE = "http://127.0.0.1:1";
const CLAUDE_SONNET_5_ID = "claude-sonnet-5";

/**
 * Deterministic registered-catalog fixture. The static fallback catalog deliberately does not
 * contain claude-sonnet-5 (an unmeasured production default must not ship just to exercise a
 * proof), so a second registration pass is served by this loopback endpoint instead: the script
 * fully controls the catalog it asserts against, offline.
 */
const FIXTURE_MODELS_RESPONSE = {
  object: "list",
  data: [
    { id: CLAUDE_SONNET_5_ID, name: CLAUDE_SONNET_5_ID, context_length: 200_000 },
    { id: "gpt-5.5", name: "gpt-5.5", context_length: 200_000 },
  ],
};

function startFixtureServer(): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === "/provider/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(FIXTURE_MODELS_RESPONSE));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "error", message: `unexpected fixture request ${request.method} ${path}` }));
  });
  return new Promise((resolveStarted, rejectStarted) => {
    server.once("error", rejectStarted);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectStarted(new Error("fixture server did not bind to a TCP port"));
        return;
      }
      resolveStarted({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, rejectClosed) => {
    server.close((error: Error | undefined) => {
      if (error !== undefined) rejectClosed(error);
      else resolveClosed();
    });
  });
}

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
  models: join(piAiDist, "models.js"),
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

  type HostModel = Record<string, unknown>;
  type HostModels = {
    getSupportedThinkingLevels(model: HostModel): string[];
    supportsXhigh(model: HostModel): boolean;
    supportsMax(model: HostModel): boolean;
  };
  const hostModels = await jiti.import<unknown>(entries.models) as HostModels;
  if (typeof hostModels.getSupportedThinkingLevels !== "function" ||
      typeof hostModels.supportsXhigh !== "function" || typeof hostModels.supportsMax !== "function") {
    throw new Error("host models module does not expose thinking-level functions");
  }

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
      const modelId = value["id"];
      const claude = modelId.toLowerCase().startsWith("claude");
      const expectedApi = claude ? "anthropic-messages" : "openai-completions";
      const expectedBase = claude ? `${API_BASE}/provider` : `${API_BASE}/provider/v1`;
      if (value["api"] !== expectedApi) problems.push(`bad api for ${modelId}`);
      if (value["baseUrl"] !== expectedBase) problems.push(`bad baseUrl for ${modelId}`);
      const model = { ...value, provider: "commandcode", api: expectedApi };
      const levels = hostModels.getSupportedThinkingLevels(model);
      if (!claude) {
        if (!hostModels.supportsXhigh(model)) throw new Error(`openai supportsXhigh assertion failed for ${modelId}`);
        if (!hostModels.supportsMax(model)) throw new Error(`openai supportsMax assertion failed for ${modelId}`);
        if (!levels.includes("xhigh") || !levels.includes("max")) {
          throw new Error(`openai supported tiers assertion failed for ${modelId}`);
        }
        const thinkingLevelMap = value["thinkingLevelMap"];
        if (!isRecord(thinkingLevelMap) || thinkingLevelMap["minimal"] !== "low") {
          throw new Error(`openai minimal map assertion failed for ${modelId}`);
        }
      } else {
        if (Object.prototype.hasOwnProperty.call(value, "thinkingLevelMap")) {
          throw new Error(`claude thinkingLevelMap omission assertion failed for ${modelId}`);
        }
      }
      if (claude) anthropic += 1;
      else openai += 1;
    }
  }
  if (anthropic === 0 || openai === 0) problems.push("both model routes were not registered");
  if (problems.length > 0) throw new Error(problems.join("; "));

  // Second registration against the loopback fixture above: the claude-sonnet-5 native-max
  // assertion is reachable here and fails loudly, instead of being vacuous against a static
  // fallback catalog that never contains that id.
  const fixture = await startFixtureServer();
  try {
    process.env["COMMANDCODE_API_BASE"] = fixture.url;
    const fixtureRegistrations: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
    await extension({
      registerProvider(name: unknown, config: unknown): void {
        if (typeof name !== "string" || !isRecord(config)) throw new Error("invalid fixture provider registration");
        fixtureRegistrations.push({ name, config });
      },
    });
    const fixtureRegistration = fixtureRegistrations[0];
    if (fixtureRegistrations.length !== 1 || fixtureRegistration === undefined) {
      throw new Error(`fixture pass expected one provider, got ${fixtureRegistrations.length}`);
    }
    const fixtureModels = fixtureRegistration.config["models"];
    if (!Array.isArray(fixtureModels)) throw new Error("fixture pass models is not an array");
    const registeredIds = fixtureModels.map((value) =>
      isRecord(value) && typeof value["id"] === "string" ? value["id"] : String(value),
    );
    if (!fixtureModels.some((value) => isRecord(value) && value["api"] === "openai-completions")) {
      throw new Error(`fixture catalog has no openai-route model (registered: ${registeredIds.join(",")})`);
    }
    const claudeSonnet5 = fixtureModels.find(
      (value): value is Record<string, unknown> => isRecord(value) && value["id"] === CLAUDE_SONNET_5_ID,
    );
    if (claudeSonnet5 === undefined) {
      throw new Error(`fixture catalog is missing ${CLAUDE_SONNET_5_ID} (registered: ${registeredIds.join(",")})`);
    }
    if (Object.prototype.hasOwnProperty.call(claudeSonnet5, "thinkingLevelMap")) {
      throw new Error(
        `${CLAUDE_SONNET_5_ID} carries an own thinkingLevelMap; native tier inference must own its levels`,
      );
    }
    const claudeModel = { ...claudeSonnet5, provider: "commandcode", api: "anthropic-messages" };
    if (!hostModels.supportsMax(claudeModel)) {
      throw new Error(`${CLAUDE_SONNET_5_ID} native max assertion failed: host supportsMax reported false`);
    }
  } finally {
    await closeServer(fixture.server);
    process.env["COMMANDCODE_API_BASE"] = API_BASE;
  }

  const openaiSample = Array.isArray(models) ? models.find((value) =>
    isRecord(value) && value["api"] === "openai-completions" && typeof value["id"] === "string",
  ) : undefined;
  const sampleTiers = isRecord(openaiSample)
    ? hostModels.getSupportedThinkingLevels({ ...openaiSample, provider: "commandcode", api: "openai-completions" }).join(",")
    : "none";
  console.log(
    `host-load-proof: PASS provider=${registration.name} registrations=${registrations.length} ` +
      `streamSimple=${typeof registration.config["streamSimple"]} ` +
      `anthropic=${anthropic} openai=${openai} openaiTiers=${sampleTiers} claudeSonnet5NativeMax=true host=${hostRoot}`,
  );
} catch (error: unknown) {
  console.error(`host-load-proof: FAILED (${error instanceof Error ? error.message : String(error)})`);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
