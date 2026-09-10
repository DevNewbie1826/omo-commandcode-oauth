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
const modes = new Set(mode?.split(",") ?? []);

class ScheduledStore extends AccountStore {
  pausedOnce = false;
  inCas = false;
  heldVerify = false;
  heldWrite = false;
  heldJournal = false;
  heldBeforeState = false;
  heldAfterState = false;
  heldGc = false;
  inGc = false;
  heldGcSnapshot = false;
  heldGcRotation = false;

  async pause(type, details = {}) {
    const resumed = once(process.stdin, "data", { signal: AbortSignal.timeout(30_000) });
    process.stdin.resume();
    console.log(JSON.stringify({ type, pid: process.pid, ...details }));
    await resumed;
    process.stdin.pause();
  }

  async readFromDisk() {
    const records = await super.readFromDisk();
    if (modes.has("pause-after-read") && !this.pausedOnce) {
      this.pausedOnce = true;
      await this.pause("held-after-read", { ids: records.map((r) => r.id) });
    }
    return records;
  }

  async captureIdentity() {
    const identity = await super.captureIdentity();
    if (modes.has("pause-after-verify") && this.inCas && !this.heldVerify) {
      this.heldVerify = true;
      await this.pause("held-after-verify", { identity });
    }
    return identity;
  }

  async persistCas(...args) {
    if (modes.has("conflict-forever")) {
      // Every attempt reports a conflict, so the cycle can never land.
      return false;
    }
    this.inCas = true;
    let landed;
    try {
      landed = await super.persistCas(...args);
    } finally {
      this.inCas = false;
    }
    if (modes.has("pause-after-write") && landed && !this.heldWrite) {
      this.heldWrite = true;
      await this.pause("held-after-write");
    }
    return landed;
  }

  async appendJournal(entry) {
    if (modes.has("pause-before-op") && entry.type === "op" && !this.heldJournal) {
      this.heldJournal = true;
      await this.pause("held-before-op");
    }
    if (
      modes.has("pause-before-state") &&
      entry.type === "op" &&
      entry.operation.kind === "state" &&
      !this.heldBeforeState
    ) {
      this.heldBeforeState = true;
      await this.pause("held-before-state", { operation: entry.operation });
    }
    await super.appendJournal(entry);
    if (modes.has("pause-after-op") && entry.type === "op" && !this.heldJournal) {
      this.heldJournal = true;
      await this.pause("held-after-op");
    }
    if (
      modes.has("pause-after-state") &&
      entry.type === "op" &&
      entry.operation.kind === "state" &&
      !this.heldAfterState
    ) {
      this.heldAfterState = true;
      await this.pause("held-after-state");
    }
  }

  async replaceJournalWithEmpty() {
    if (modes.has("pause-before-gc") && !this.heldGc) {
      this.heldGc = true;
      await this.pause("held-before-gc");
    }
    this.inGc = true;
    try {
      await super.replaceJournalWithEmpty();
    } finally {
      this.inGc = false;
    }
  }

  async readJournal() {
    const snapshot = await super.readJournal();
    if (modes.has("pause-in-gc-after-journal-read") && this.inGc && !this.heldGcSnapshot) {
      this.heldGcSnapshot = true;
      await this.pause("held-in-gc-after-journal-read", { entries: snapshot.entries.length });
    }
    return snapshot;
  }

  async rotateLiveJournal(...args) {
    if (modes.has("pause-before-gc-rotation") && !this.heldGcRotation) {
      this.heldGcRotation = true;
      await this.pause("held-before-gc-rotation");
    }
    return super.rotateLiveJournal(...args);
  }

  async withJournalLock(task) {
    return super.withJournalLock(async () => {
      if (modes.has("pause-with-lock")) await this.pause("held-with-lock");
      return task();
    });
  }
}

try {
  const store = new ScheduledStore({
    path,
    now: () => 1_700_000_000_000,
    journalLockStaleMs: modes.has("steal-lock-now")
      ? 0
      : modes.has("short-stale-lock")
        ? 50
        : undefined,
  });
  let transformCalls = 0;
  if (action === "load") await store.load();
  else if (action === "add") await store.add({
    id,
    token,
    ...(value.length === 0 ? {} : { keyName: value }),
  });
  else if (action === "add-json") await store.add(JSON.parse(value));
  else if (action === "state") {
    await store.mutate((records) =>
      records.map((record) => (record.id === id ? { ...record, keyName: value } : record)),
    );
  } else if (["increment", "toggle", "saturate", "reordered-increment"].includes(action)) {
    await store.mutate((records) => {
      transformCalls += 1;
      return records.map((record) => {
        if (record.id !== id) return record;
        if (action === "toggle") return { ...record, enabled: !record.enabled };
        const monthly = action === "saturate"
          ? Math.min(3, (record.credits?.monthly ?? 0) + 1)
          : (record.credits?.monthly ?? 0) + 1;
        if (action === "reordered-increment" && record.credits !== undefined) {
          return {
            ...record,
            credits: {
              monthly,
              free: record.credits.free,
              purchased: record.credits.purchased,
              periodEnd: record.credits.periodEnd,
            },
          };
        }
        return { ...record, credits: { ...record.credits, monthly } };
      });
    });
  } else {
    throw new Error(`unknown fixture action: ${action}`);
  }
  console.log(
    JSON.stringify({
      type: "persisted",
      pid: process.pid,
      id,
      ids: store.accounts().map((record) => record.id),
      transformCalls,
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
