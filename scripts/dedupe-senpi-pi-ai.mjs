import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const nestedScope = join(
  process.cwd(),
  "node_modules",
  "@code-yeongyu",
  "senpi",
  "node_modules",
  "@earendil-works",
);
const topLevelPackage = join(
  process.cwd(),
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "package.json",
);

try {
  if (!existsSync(nestedScope) || !existsSync(topLevelPackage)) {
    process.exitCode = 0;
  } else {
    const packageJson = JSON.parse(readFileSync(topLevelPackage, "utf8"));
    const nestedPackage = join(nestedScope, "pi-ai", "package.json");
    if (packageJson?.name === "@code-yeongyu/senpi-ai" && existsSync(nestedPackage)) {
      const nestedJson = JSON.parse(readFileSync(nestedPackage, "utf8"));
      if (nestedJson?.name === "@earendil-works/pi-ai" && nestedJson?.version === packageJson.version) {
        rmSync(nestedScope, { recursive: true, force: true });
      }
    }
    process.exitCode = 0;
  }
} catch (error) {
  void error;
  process.exitCode = 0;
}
