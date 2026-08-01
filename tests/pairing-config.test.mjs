import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("one-drag setup writer creates gitignored pairing files without printing secrets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-pairing-"));
  const input = {
    siteUrl: "https://private.example",
    siwcBypassToken: "example-bypass-token-that-is-not-real",
    cwd: directory,
    deviceLabel: "测试电脑",
  };
  const script = fileURLToPath(new URL("../scripts/write-pairing-config.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, TEAM_ROOM_CONFIG_DIR: path.join(directory, "config") },
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(input.siwcBypassToken), false);
  const output = JSON.parse(result.stdout);
  const pairing = JSON.parse(fs.readFileSync(output.configPath, "utf8"));
  const environment = JSON.parse(fs.readFileSync(output.sitesEnvironmentPath, "utf8"));
  assert.equal(pairing.siteUrl, input.siteUrl);
  assert.equal(pairing.cwd, directory);
  assert.equal(pairing.deviceSecret, environment.TEAM_ROOM_DEVICE_SECRET);
  assert.deepEqual(Object.keys(environment), ["TEAM_ROOM_DEVICE_SECRET"]);
  fs.rmSync(directory, { recursive: true, force: true });
});
