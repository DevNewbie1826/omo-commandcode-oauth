// Fixture for test/test-store-atomicity.test.ts: a REAL separate process that
// mutates the accounts file through AccountStore, so cross-process store
// mutation is exercised against actual concurrent OS processes.
//
// Usage: <runtime> pausable-store-child.mjs <accountsPath> <id> [mode]
//
// Modes:
// - (absent): add the account and exit.
// - "pause-after-read": after the first read of the file — which happens
//   AFTER the store captured the file's identity — emit one JSON line and
//   wait for the parent to write anything to stdin before continuing. This
//   parks the child in the read-to-verify window where a peer writer's
//   persist must be detected as an identity conflict.
// - "conflict-forever": force every optimistic-concurrency write attempt to
//   report a conflict, so the store exhausts its bounded retry budget; used
//   to assert the typed give-up error and that no temp or lock residue is
//   left behind.
//
// Protocol: one JSON line per step on stdout. Run with bun (it imports the
// TypeScript store directly).
import { once } from "node:events";
import { AccountStore } from "../../extensions/commandcode/accounts/store.ts";

const [path, id, mode] = process.argv.slice(2);

class ScheduledStore extends AccountStore {
  pausedOnce = false;

  async readFromDisk() {
    const records = await super.readFromDisk();
    if (mode === "pause-after-read" && !this.pausedOnce) {
      this.pausedOnce = true;
      console.log(
        JSON.stringify({ type: "held-after-read", pid: process.pid, ids: records.map((r) => r.id) }),
      );
      await once(process.stdin, "data", { signal: AbortSignal.timeout(30_000) });
      process.stdin.pause();
    }
    return records;
  }

  async persistCas() {
    if (mode === "conflict-forever") {
      // Every attempt reports a conflict, so the cycle can never land.
      return false;
    }
    return super.persistCas(...arguments);
  }
}

try {
  const store = new ScheduledStore({ path });
  await store.add({ id, token: `token-${id}` });
  console.log(JSON.stringify({ type: "persisted", pid: process.pid, id }));
} catch (error) {
  console.log(
    JSON.stringify({
      type: "error",
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
