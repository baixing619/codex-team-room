import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { RemotePairingBridge } from "../server/remotePairingBridge.mjs";

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

test("pairing writer rejects an empty project directory instead of resolving it to the installer cwd", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-pairing-empty-"));
  const script = fileURLToPath(new URL("../scripts/write-pairing-config.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ siteUrl: "https://private.example", siwcBypassToken: "example-bypass-token-that-is-not-real", cwd: "" }),
    encoding: "utf8",
    env: { ...process.env, TEAM_ROOM_CONFIG_DIR: path.join(directory, "config") },
    windowsHide: true,
  });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(directory, "config", "pairing.json")), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("pairing bridge refuses a saved project directory that has been moved", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-pairing-moved-"));
  const configPath = path.join(directory, "pairing.json");
  fs.writeFileSync(configPath, JSON.stringify({
    siteUrl: "https://private.example",
    siwcBypassToken: "example-bypass-token-that-is-not-real",
    deviceSecret: "example-device-secret-that-is-not-real",
    cwd: path.join(directory, "missing-project"),
  }));
  const bridge = new RemotePairingBridge({ configPath, runtime: {}, timers: { setInterval() { throw new Error("must_not_start"); } } });

  assert.deepEqual(bridge.start(), {
    configured: false,
    running: false,
    siteUrl: null,
    deviceId: null,
    deviceLabel: null,
    cwd: null,
    activeTaskId: null,
    lastError: null,
  });
  fs.rmSync(directory, { recursive: true, force: true });
});
