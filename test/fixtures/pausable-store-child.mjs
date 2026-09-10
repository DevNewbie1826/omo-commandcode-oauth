// Fixture for test/test-store-atomicity.test.ts: a REAL separate process that
// mutates the accounts file through AccountStore, so cross-process lock
// ownership is exercised against actual concurrent OS processes.
//
// Usage: <runtime> pausable-store-child.mjs <accountsPath> <id> [hold]
//
// In "hold" mode the child pauses after its lock-held read but BEFORE the
// ownership re-check and write — exactly the "locked + read + paused" writer
// state the ownership tests model. The parent resumes it by writing anything
// to stdin. Protocol: one JSON line per step on stdout.
//
// Run with bun (it imports the TypeScript store directly).
import { once } from "node:events";
import { AccountStore } from "../../extensions/commandcode/accounts/store.ts";

const [path, id, mode] = process.argv.slice(2);

class PausableStore extends AccountStore {
  constructor(options) {
    super(options);
    this.heldOnce = false;
  }

  async readFromDisk() {
    const records = await super.readFromDisk();
    if (mode === "hold" && !this.heldOnce) {
      this.heldOnce = true;
      console.log(
        JSON.stringify({ type: "held-after-read", pid: process.pid, ids: records.map((r) => r.id) }),
      );
      await once(process.stdin, "data", { signal: AbortSignal.timeout(30_000) });
      process.stdin.pause();
    }
    return records;
  }
}

const store = new PausableStore({ path });
await store.add({ id, token: `token-${id}` });
console.log(JSON.stringify({ type: "persisted", pid: process.pid, id }));
