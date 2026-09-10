import { access } from "node:fs/promises";

const entrypoint = "/tmp/st_01a08c94-child.mjs";
const outputs = [
  "/tmp/st_01a08caa-compiled-child.mjs",
  "/tmp/st_01a08cf8-c94-compiled.mjs",
];

await access(entrypoint);
for (const outfile of outputs) {
  const build = Bun.spawn(
    ["bun", "build", entrypoint, "--target=node", `--outfile=${outfile}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await build.exited;
  if (exitCode !== 0) {
    throw new Error(`probe bundle build failed for ${outfile} with exit ${exitCode}`);
  }
}

console.log(`rebuilt ${outputs.join(" and ")} from ${entrypoint}`);
