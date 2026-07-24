import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const tscEntrypoint = join(root, "node_modules", "typescript", "bin", "tsc");

function fail(message, error) {
  console.error(`[build] ${message}`);
  if (error) console.error(error);
  process.exit(1);
}

function runTypeScriptCompiler(projectFile) {
  if (!existsSync(tscEntrypoint)) {
    fail("TypeScript is not installed. Run `npm install` first.");
  }

  const result = spawnSync(process.execPath, [tscEntrypoint, "-p", projectFile], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true
  });

  if (result.error) fail("Could not start the TypeScript compiler.", result.error);
  if (result.signal) fail(`TypeScript compiler terminated by signal ${result.signal}.`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv.includes("--clean")) {
  await rm(dist, { recursive: true, force: true });
  console.log(`[build] Removed ${dist}`);
  process.exit(0);
}

try {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  runTypeScriptCompiler("tsconfig.json");

  await cp(join(root, "manifest.json"), join(dist, "manifest.json"));
  await cp(join(root, "assets"), join(dist, "assets"), { recursive: true });

  for (const area of ["content", "popup", "options", "history"]) {
    const source = join(root, "src", area);
    const target = join(dist, "src", area);
    await mkdir(target, { recursive: true });

    const files = await readdir(source);
    for (const file of files) {
      if (file.endsWith(".html") || file.endsWith(".css")) {
        await cp(join(source, file), join(target, file));
      }
    }
  }

  if (!existsSync(join(dist, "manifest.json"))) {
    fail("Build completed without dist/manifest.json.");
  }

  console.log(`[build] Built extension at ${dist}`);
} catch (error) {
  fail("Build failed.", error);
}
