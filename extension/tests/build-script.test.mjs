import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("Windows-safe build creates dist/manifest.json", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(root, "dist", "manifest.json")), true);
  assert.match(result.stdout, /Built extension/);
});
