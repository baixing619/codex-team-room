#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const portArgument = process.argv.slice(2).find((value) => value.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) || 4174);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
const restart = args.has("--restart");
const stopAfterVerify = args.has("--stop-after-verify");
const stateDirectory = path.join(root, ".team-room");
const logDirectory = path.join(stateDirectory, "logs");
const pidPath = path.join(stateDirectory, port === 4174 ? "local-server.pid" : `local-server-${port}.pid`);

function requestHealth() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 1800 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(response.statusCode === 200 && value.ok === true && value.mode === "local-index" ? value : null);
        } catch { resolve(null); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(null));
  });
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopRecordedServer() {
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidPath, "utf8").trim()); } catch {}
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    await waitForExit(pid);
  }
  fs.rmSync(pidPath, { force: true });
}

fs.mkdirSync(logDirectory, { recursive: true });
if (restart) await stopRecordedServer();

let health = await requestHealth();
let child = null;
let startedHere = false;
if (health) {
  if (!health.serviceRoot || path.resolve(health.serviceRoot).toLowerCase() !== root.toLowerCase()) {
    throw new Error(`port_${port}_used_by_another_service`);
  }
} else {
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(vite)) throw new Error("dependencies_missing_run_installer");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutPath = path.join(logDirectory, `server-${stamp}.out.log`);
  const stderrPath = path.join(logDirectory, `server-${stamp}.err.log`);
  const stdout = fs.openSync(stdoutPath, "a");
  const stderr = fs.openSync(stderrPath, "a");
  child = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", stdout, stderr],
  });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  child.unref();
  fs.writeFileSync(pidPath, `${child.pid}\n`, "ascii");
  startedHere = true;
  const deadline = Date.now() + 25_000;
  while (!health && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    health = await requestHealth();
  }
  if (!health) {
    await stopRecordedServer();
    const detail = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8").slice(-2000) : "";
    throw new Error(`local_service_health_timeout${detail ? `: ${detail}` : ""}`);
  }
}

const result = {
  ok: true,
  url: `http://127.0.0.1:${port}/`,
  serviceRoot: root,
  pid: child?.pid || Number(fs.existsSync(pidPath) ? fs.readFileSync(pidPath, "utf8").trim() : 0) || null,
  reused: !startedHere,
};
if (stopAfterVerify && startedHere) {
  await stopRecordedServer();
  result.stoppedAfterVerify = true;
}
console.log(JSON.stringify(result));
