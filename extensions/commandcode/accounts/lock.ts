import { createServer, type Server } from "node:net";
import { AccountStoreError } from "./schema.js";

const LOCK_WAIT_MS = 2_000;
const LOCK_RECHECK_MS = 25;
// One kernel exclusion domain serializes every Command Code accounts management write,
// including writes through pathname aliases and writes to different accounts files.
const ACCOUNTS_MANAGEMENT_LOCK_PORT = 41_059;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function listen(port: number): Promise<Server> {
  return new Promise((resolveListen, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (cause: Error): void => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // exclusive and reusePort:false prevent sharing or stealing the listening socket.
    server.listen({ host: "127.0.0.1", port, exclusive: true, reusePort: false });
  });
}

function wait(waitMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, Math.min(waitMs, LOCK_RECHECK_MS));
  });
}

async function acquire(accountsPath: string): Promise<Server> {
  const port = ACCOUNTS_MANAGEMENT_LOCK_PORT;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      return await listen(port);
    } catch (cause) {
      if (codeOf(cause) !== "EADDRINUSE") {
        throw new AccountStoreError(
          `Could not acquire accounts lock for ${accountsPath} on 127.0.0.1:${port}`,
          { cause },
        );
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new AccountStoreError(
        `Timed out waiting for accounts lock for ${accountsPath} on 127.0.0.1:${port}`,
      );
    }
    await wait(remaining);
  }
}

function release(server: Server, accountsPath: string): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolveClose();
      else reject(new AccountStoreError(`Could not release accounts lock for ${accountsPath}`, { cause }));
    });
  });
}

export async function withAccountLock<T>(accountsPath: string, operation: () => Promise<T>): Promise<T> {
  const server = await acquire(accountsPath);
  try {
    return await operation();
  } finally {
    await release(server, accountsPath);
  }
}
