import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("public download contains a deterministic Windows installer and safe one-drag instructions", () => {
  const cmd = fs.readFileSync(path.join(root, "install-team-room.cmd"), "utf8");
  const installer = fs.readFileSync(path.join(root, "scripts", "install-windows.mjs"), "utf8");
  const starter = fs.readFileSync(path.join(root, "scripts", "start-team-room.mjs"), "utf8");
  const setup = fs.readFileSync(path.join(root, "CODEX_SETUP.md"), "utf8");

  assert.match(cmd, /install-windows\.mjs/);
  assert.match(installer, /runNpm\(\["ci"/);
  assert.match(installer, /stop-after-verify/);
  assert.doesNotMatch(installer, /auth\.json|login status/);
  assert.doesNotMatch(cmd + installer + starter, /powershell(?:\.exe)?|-ExecutionPolicy/i);
  assert.match(setup, /site:prepare-personal/);
  assert.match(setup, /install-team-room\.cmd/);
  assert.doesNotMatch(setup, /codex login status/);
});
