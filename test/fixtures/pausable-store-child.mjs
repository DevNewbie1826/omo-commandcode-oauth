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

const [path, id, mode, action = "add", token = `token-${id}`, value = ""] = process.argv.slice(2);

class ScheduledStore extends AccountStore {
  pausedOnce = false;
  captures = 0;
  heldWrite = false;
  heldJournal = false;
  heldGc = false;

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

  async persistCas(...args) {
    if (mode === "conflict-forever") {
      // Every attempt reports a conflict, so the cycle can never land.
      return false;
    }
    const landed = await super.persistCas(...args);
    if (mode === "pause-after-write" && landed && !this.heldWrite) {
      this.heldWrite = true;
      await this.pause("held-after-write");
    }
    return landed;
  }

  async appendJournal(entry) {
    if (mode === "pause-before-op" && entry.type === "op" && !this.heldJournal) {
      this.heldJournal = true;
      await this.pause("held-before-op");
    }
    await super.appendJournal(entry);
    if (mode === "pause-after-op" && entry.type === "op" && !this.heldJournal) {
      this.heldJournal = true;
      await this.pause("held-after-op");
    }
  }

  async replaceJournalWithEmpty() {
    if (mode === "pause-before-gc" && !this.heldGc) {
      this.heldGc = true;
      await this.pause("held-before-gc");
    }
    await super.replaceJournalWithEmpty();
  }
}

try {
  const store = new ScheduledStore({ path, now: () => 1_700_000_000_000 });
  if (action === "load") await store.load();
  else if (action === "add") await store.add({ id, token });
  else if (action === "state") {
    await store.mutate((records) =>
      records.map((record) => (record.id === id ? { ...record, keyName: value } : record)),
    );
  } else {
    throw new Error(`unknown fixture action: ${action}`);
  }
  console.log(
    JSON.stringify({
      type: "persisted",
      pid: process.pid,
      id,
      ids: store.accounts().map((record) => record.id),
    }),
  );
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
