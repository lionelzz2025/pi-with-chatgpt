#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist", "cli", "index.js");

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  // Source checkout / git-installed Pi package fallback. Resolve tsx relative
  // to this package, not the user's current workspace.
  const entry = path.join(here, "..", "src", "cli", "index.ts");
  const tsxLoader = import.meta.resolve("tsx/esm");
  const result = spawnSync(process.execPath, ["--import", tsxLoader, entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
