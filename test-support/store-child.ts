import { rename } from "node:fs/promises";
import { AccountStore } from "../extensions/commandcode/accounts/store.js";

const path = process.env.STORE_PATH;
const id = process.env.ACCOUNT_ID;
if (path === undefined || id === undefined || process.send === undefined) {
  throw new Error("Store child requires IPC, STORE_PATH, and ACCOUNT_ID");
}

let releaseRename: (() => void) | undefined;
const renameGate = new Promise<void>((resolve) => { releaseRename = resolve; });
const store = new AccountStore({
  path,
  renameImpl: async (from, to) => {
    process.send?.({ type: "rename", id });
    await renameGate;
    await rename(from, to);
  },
});

process.on("message", (message: unknown) => {
  if (message === "release") releaseRename?.();
  if (message === "start" || (typeof message === "object" && message !== null && "start" in message)) {
    const offset = typeof message === "object" && message !== null && "nowOffset" in message
      && typeof message.nowOffset === "number" ? message.nowOffset : 0;
    const realNow = Date.now;
    Date.now = () => realNow() + offset;
    void store.add({ id, token: `token-${id}` }).then(
      () => process.send?.({ type: "done", id }, () => process.disconnect()),
      (error: unknown) => process.send?.({
        type: "failed",
        id,
        name: error instanceof Error ? error.name : undefined,
        message: error instanceof Error ? error.message : String(error),
      }, () => process.disconnect()),
    );
  }
});
process.send({ type: "ready", id });
