import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const EXPOSED_PI_AI_SPECIFIERS = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
]);

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : Promise.resolve(path.endsWith(".ts") ? [path] : []);
  }));
  return nested.flat();
}

describe("host extension import surface", () => {
  it("uses only pi-ai specifiers exposed by the senpi extension loader", async () => {
    const extensionRoot = join(process.cwd(), "extensions");
    const violations: string[] = [];
    for (const path of await sourceFiles(extensionRoot)) {
      const source = await readFile(path, "utf8");
      const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["'](@earendil-works\/pi-ai(?:\/[^"']*)?)["']/g);
      for (const match of imports) {
        const specifier = match[1];
        if (specifier !== undefined && !EXPOSED_PI_AI_SPECIFIERS.has(specifier)) {
          violations.push(`${relative(process.cwd(), path)}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
