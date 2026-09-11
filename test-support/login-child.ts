import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Server } from "node:net";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { CommandCodeHost } from "../extensions/commandcode/index.js";

const accountsPath = process.env.COMMANDCODE_ACCOUNTS_FILE;
const id = process.env.ACCOUNT_ID;
if (accountsPath === undefined || id === undefined || process.send === undefined) {
  throw new Error("Login child requires IPC, COMMANDCODE_ACCOUNTS_FILE, and ACCOUNT_ID");
}

function emit(message: object, callback?: () => void): void {
  if (callback === undefined) process.send!(message);
  else process.send!(message, callback);
}

const realListen = Server.prototype.listen;
Object.defineProperty(Server.prototype, "listen", {
  configurable: true,
  value(this: Server, ...args: unknown[]): Server {
    this.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") emit({ type: "contended", id });
    });
    return Reflect.apply(realListen, this, args) as Server;
  },
});

const realRename = fs.promises.rename;
let releaseRename: (() => void) | undefined;
const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
fs.promises.rename = async (from, to): Promise<void> => {
  if (String(to) === accountsPath) {
    emit({ type: "rename", id });
    await renameGate;
  }
  await realRename(from, to);
};
syncBuiltinESMExports();

const { default: extension } = await import("../extensions/commandcode/index.js");
let provider: ProviderConfig | undefined;
const host: CommandCodeHost = {
  registerProvider: (_name, config) => { provider = config; },
};
await extension(host);
const login = provider?.oauth?.login;
if (login === undefined) throw new Error("Command Code oauth.login was not registered");

const callbacks: OAuthLoginCallbacks = {
  onAuth(info) {
    const authUrl = new URL(info.url);
    const callback = authUrl.searchParams.get("callback");
    const state = authUrl.searchParams.get("state");
    if (callback === null || state === null) throw new Error("Login URL omitted callback or state");
    void fetch(`${callback}?${new URLSearchParams({
      apiKey: `token-${id}`,
      state,
      userId: `user-${id}`,
      userName: id,
      keyName: `key-${id}`,
    })}`).then((response) => {
      if (!response.ok) throw new Error(`Callback failed with ${response.status}`);
    });
  },
  onDeviceCode() {},
  async onPrompt() { throw new Error("Registered login unexpectedly requested pasted credentials"); },
  async onSelect() { return undefined; },
};

process.on("message", (message: unknown) => {
  if (message === "release") releaseRename?.();
  if (message === "start") {
    emit({ type: "starting", id });
    void login(callbacks).then(
      (credentials) => emit({ type: "done", id, token: credentials.access }, () => process.disconnect()),
      (error: unknown) => emit({
        type: "failed",
        id,
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
      }, () => process.disconnect()),
    );
  }
});
emit({ type: "ready", id });
