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
  if (message === "start") {
    void store.add({ id, token: `token-${id}` }).then(
      () => process.send?.({ type: "done", id }, () => process.disconnect()),
      (error: unknown) => process.send?.({
        type: "failed",
        id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});
process.send({ type: "ready", id });
