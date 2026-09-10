/**
 * `AccountStore` owns the multi-account credential file: it loads and
 * validates the file at the boundary, persists every mutation atomically
 * (temp file + rename, mode 0600), and serializes writes through a simple
 * in-process mutex so concurrent mutations cannot interleave.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AccountStoreError,
  parseAccountFile,
  serializeAccountFile,
  type AccountRecord,
  type AccountRecordInput,
} from "./schema.js";

/** Accounts file location: `COMMANDCODE_ACCOUNTS_FILE` else `~/.commandcode/omo-accounts.json`. */
export function resolveAccountsFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env["COMMANDCODE_ACCOUNTS_FILE"];
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".commandcode", "omo-accounts.json");
}

export interface AccountStoreOptions {
  readonly path: string;
  /** Injected clock used to default `createdAt` on newly added accounts. */
  readonly now?: () => number;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class AccountStore {
  private records: readonly AccountRecord[] = [];
  private writeTail: Promise<unknown> = Promise.resolve();
  private readonly clock: () => number;

  constructor(private readonly options: AccountStoreOptions) {
    this.clock = options.now ?? (() => Date.now());
  }

  /** In-memory snapshot of the last loaded/persisted state. */
  accounts(): readonly AccountRecord[] {
    return this.records;
  }

  /**
   * (Re)read the file from disk and return the validated records. A missing
   * file yields an empty store; a malformed file throws `AccountStoreError`
   * and leaves previously loaded state untouched.
   */
  async load(): Promise<readonly AccountRecord[]> {
    return this.exclusive(async () => {
      this.records = await this.readFromDisk();
      return this.records;
    });
  }

  /** Append an account; rejects duplicate ids and duplicate credentials. */
  async add(input: AccountRecordInput): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.readFromDisk();
      if (records.some((record) => record.id === input.id)) {
        throw new AccountStoreError(`Account id already exists: ${input.id}`);
      }
      if (records.some((record) => record.token === input.token)) {
        throw new AccountStoreError("Account credential already exists");
      }
      const next = [...records, this.normalize(input)];
      await this.persist(next);
      this.records = next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.readFromDisk();
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      const next = records.filter((record) => record.id !== id);
      await this.persist(next);
      this.records = next;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.readFromDisk();
      if (!records.some((record) => record.id === id)) {
        throw new AccountStoreError(`Unknown account id: ${id}`);
      }
      const next = records.map((record) => (record.id === id ? { ...record, enabled } : record));
      await this.persist(next);
      this.records = next;
    });
  }

  /**
   * Read-modify-write escape hatch under the same write serialization as
   * add/remove/setEnabled. The transform must return the full next record
   * list; it is persisted atomically.
   */
  async mutate(
    transform: (records: readonly AccountRecord[]) => readonly AccountRecord[],
  ): Promise<void> {
    await this.exclusive(async () => {
      const records = await this.readFromDisk();
      const next = transform(records);
      await this.persist(next);
      this.records = next;
    });
  }

  private normalize(input: AccountRecordInput): AccountRecord {
    const createdAt = input.createdAt ?? new Date(this.clock()).toISOString();
    return { ...input, enabled: input.enabled ?? true, createdAt };
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeTail.then(task, task);
    this.writeTail = run.catch(() => undefined);
    return run;
  }

  private async readFromDisk(): Promise<readonly AccountRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.options.path, "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw new AccountStoreError(
        `Could not read accounts file at ${this.options.path}`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new AccountStoreError(
        `Accounts file at ${this.options.path} is not valid JSON`,
        { cause: error },
      );
    }

    return parseAccountFile(parsed).accounts;
  }

  private async persist(records: readonly AccountRecord[]): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true });
    const temporaryPath = `${this.options.path}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, serializeAccountFile(records), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.options.path);
    } finally {
      try {
        await rm(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup of the temp file must not mask the original write error.
      }
    }
  }
}
