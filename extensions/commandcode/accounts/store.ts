import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountStoreError,
  parseAccountFile,
  parseAccountRecords,
  serializeAccountFile,
  type AccountRecord,
  type AccountRecordInput,
} from "./schema.js";

const MAX_CAS_ATTEMPTS = 8;
const pathQueues = new Map<string, Promise<void>>();

export interface AccountStoreOptions {
  readonly path: string;
  readonly now?: () => number;
}

export function resolveAccountsFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env["COMMANDCODE_ACCOUNTS_FILE"];
  return override === undefined || override.length === 0
    ? join(homedir(), ".commandcode", "omo-accounts.json")
    : override;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export class AccountStore {
  private readonly clock: () => number;
  private records: readonly AccountRecord[] = [];

  constructor(private readonly options: AccountStoreOptions) {
    this.clock = options.now ?? Date.now;
  }

  accounts(): readonly AccountRecord[] {
    return this.records;
  }

  async load(): Promise<readonly AccountRecord[]> {
    const contents = await this.readRaw();
    if (contents === undefined) {
      this.records = [];
      return this.records;
    }
    try {
      this.records = parseAccountFile(JSON.parse(contents)).accounts;
      return this.records;
    } catch (cause) {
      if (cause instanceof AccountStoreError) throw cause;
      throw new AccountStoreError(`Accounts file at ${this.options.path} is not valid JSON`, { cause });
    }
  }

  async add(input: AccountRecordInput): Promise<void> {
    const createdAt = input.createdAt ?? new Date(this.clock()).toISOString();
    const record = parseAccountRecords([{ ...input, enabled: input.enabled ?? true, createdAt }])[0]!;
    await this.update((records) => {
      if (records.some((candidate) => candidate.id === record.id)) {
        throw new AccountStoreError(`Account id already exists: ${record.id}`);
      }
      if (records.some((candidate) => candidate.token === record.token)) {
        throw new AccountStoreError("Account credential already exists");
      }
      return [...records, record];
    });
  }

  async remove(id: string): Promise<void> {
    await this.update((records) => {
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      return records.filter((record) => record.id !== id);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.update((records) => {
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      return records.map((record) => (record.id === id ? { ...record, enabled } : record));
    });
  }

  private async update(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    const previous = pathQueues.get(this.options.path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    pathQueues.set(this.options.path, queued);
    await previous;
    try {
      await this.compareAndSwap(transform);
    } finally {
      release();
      if (pathQueues.get(this.options.path) === queued) pathQueues.delete(this.options.path);
    }
  }

  private async compareAndSwap(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const before = await this.readRaw();
      let records: readonly AccountRecord[] = [];
      if (before !== undefined) {
        try {
          records = parseAccountFile(JSON.parse(before)).accounts;
        } catch (cause) {
          if (cause instanceof AccountStoreError) throw cause;
          throw new AccountStoreError(`Accounts file at ${this.options.path} is not valid JSON`, {
            cause,
          });
        }
      }
      const next = parseAccountRecords(transform(records));
      const temporary = `${this.options.path}.tmp-${process.pid}-${randomUUID()}`;
      await this.writeTemporary(temporary, serializeAccountFile(next));
      try {
        if (before !== await this.readRaw()) continue;
        await rename(temporary, this.options.path);
        this.records = next;
        return;
      } catch (cause) {
        throw new AccountStoreError(`Could not atomically replace accounts file at ${this.options.path}`, {
          cause,
        });
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    throw new AccountStoreError(
      `Accounts file at ${this.options.path} kept changing; concurrent modification`,
    );
  }

  private async writeTemporary(path: string, contents: string): Promise<void> {
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      await rm(path, { force: true }).catch(() => undefined);
      throw new AccountStoreError(`Could not persist accounts file at ${this.options.path}`, { cause });
    }
  }

  private async readRaw(): Promise<string | undefined> {
    try {
      return await readFile(this.options.path, "utf-8");
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") return undefined;
      throw new AccountStoreError(
        `Could not read accounts file at ${this.options.path}: ${messageOf(cause)}`,
        { cause },
      );
    }
  }
}
