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
// - "pause-after-verify": after persistCas performs its final identity
//   verification, pause before rename. This is the residual cross-process
//   check-then-write window.
// - "pause-after-write": after the account-file rename lands, pause before
//   the mutation returns. This coordinates the strongest three-writer race.
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
  captures = 0;
  heldWrite = false;

  async pause(type, details = {}) {
    const resumed = once(process.stdin, "data", { signal: AbortSignal.timeout(30_000) });
    process.stdin.resume();
    console.log(JSON.stringify({ type, pid: process.pid, ...details }));
    await resumed;
    process.stdin.pause();
  }

  async readFromDisk() {
    const records = await super.readFromDisk();
    if (mode === "pause-after-read" && !this.pausedOnce) {
      this.pausedOnce = true;
      await this.pause("held-after-read", { ids: records.map((r) => r.id) });
    }
    return records;
  }

  async captureIdentity() {
    const identity = await super.captureIdentity();
    this.captures += 1;
    if (mode === "pause-after-verify" && this.captures === 2) {
      await this.pause("held-after-verify", { identity });
    }
    return identity;
  }

  async persistCas() {
    if (mode === "conflict-forever") {
      // Every attempt reports a conflict, so the cycle can never land.
      return false;
    }
    const landed = await super.persistCas(...arguments);
    if (mode === "pause-after-write" && landed && !this.heldWrite) {
      this.heldWrite = true;
      await this.pause("held-after-write");
    }
    return landed;
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
