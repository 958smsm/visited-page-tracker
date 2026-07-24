import { readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, ".test-build");
const testsDirectory = join(root, "tests");
const tscEntrypoint = join(root, "node_modules", "typescript", "bin", "tsc");

function fail(message, error) {
  console.error(`[test] ${message}`);
  if (error) console.error(error);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true
  });

  if (result.error) fail(`Could not start ${command}.`, result.error);
  if (result.signal) fail(`Process terminated by signal ${result.signal}.`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  if (!existsSync(tscEntrypoint)) {
    fail("TypeScript is not installed. Run `npm install` first.");
  }

  await rm(build, { recursive: true, force: true });
  run(process.execPath, [tscEntrypoint, "-p", "tsconfig.test.json"]);
  await writeFile(join(build, "package.json"), '{"type":"commonjs"}\n');

  const testFiles = (await readdir(testsDirectory))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join(testsDirectory, name));

  if (testFiles.length === 0) fail("No test files were found.");

  console.log(`[test] Running ${testFiles.length} test files...`);
  run(process.execPath, ["--test", ...testFiles]);
  console.log("[test] All tests passed.");
} catch (error) {
  fail("Test run failed.", error);
}
