import { rename } from "node:fs/promises";
import { Server } from "node:net";
import { createInterface } from "node:readline";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";

const path = process.env.STORE_PATH;
const id = process.env.ACCOUNT_ID;
if (path === undefined || id === undefined) {
  throw new Error("Store child requires STORE_PATH and ACCOUNT_ID");
}

function emit(message: object, callback?: () => void): void {
  if (process.send !== undefined) {
    if (callback === undefined) process.send(message);
    else process.send(message, callback);
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    callback?.();
  }
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

let releaseRename: (() => void) | undefined;
const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
const store = new AccountStore({
  path,
  renameImpl: async (from, to) => {
    emit({ type: "rename", id });
    await renameGate;
    await rename(from, to);
  },
});

function handle(message: unknown): void {
  if (message === "release") releaseRename?.();
  if (message === "start" || (typeof message === "object" && message !== null && "start" in message)) {
    const offset = typeof message === "object" && message !== null && "nowOffset" in message
      && typeof message.nowOffset === "number" ? message.nowOffset : 0;
    const realNow = Date.now;
    Date.now = () => realNow() + offset;
    const addition = store.add({ id: id!, token: `token-${id}` });
    emit({ type: "starting", id });
    void addition.then(
      () => emit({ type: "done", id }, () => process.disconnect?.()),
      (error: unknown) => emit({
        type: "failed",
        id,
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
      }, () => process.disconnect?.()),
    );
  }
}

if (process.send !== undefined) process.on("message", handle);
else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    handle(line.startsWith("{") ? JSON.parse(line) : line);
  });
}
emit({ type: "ready", id });
