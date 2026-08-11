#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const portArgument = rawArgs.find((value) => value.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) || 4174);
const noAutoStart = args.has("--no-autostart") || args.has("--stop-after-verify");
const noOpen = args.has("--no-open") || args.has("--stop-after-verify");
const skipNodeInstall = args.has("--skip-node-install");
const skipCodexInstall = args.has("--skip-codex-install");
const skipCodexCheck = args.has("--skip-codex-check");

function step(message) { process.stdout.write(`\n==> ${message}\n`); }

function run(command, commandArgs, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: false,
    shell: false,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw result.error || new Error(`${path.basename(command)}_failed_${result.status}`);
  }
  return result;
}

function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return (major === 20 && minor >= 19) || (major >= 22 && (major !== 22 || minor >= 12));
}

function where(name) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout).split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
}

function findNpmCli() {
  const candidates = [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  for (const command of where(process.platform === "win32" ? "npm.cmd" : "npm")) {
    candidates.push(path.join(path.dirname(command), "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function codexCandidates() {
  const candidates = where("codex");
  if (process.platform === "win32" && process.env.APPDATA) {
    const arm64 = process.arch === "arm64";
    const packageName = arm64 ? "codex-win32-arm64" : "codex-win32-x64";
    const target = arm64 ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    candidates.unshift(path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe"));
  }
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate));
}

function verifyCodex() {
  for (const candidate of codexCandidates()) {
    const result = run(candidate, ["--version"], { capture: true, allowFailure: true });
    if (!result.error && result.status === 0) {
      process.stdout.write(String(result.stdout || result.stderr || "").trim() + "\n");
      return true;
    }
  }
  return false;
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_port");
const packagePath = path.join(root, "package.json");
if (!fs.existsSync(packagePath) || JSON.parse(fs.readFileSync(packagePath, "utf8")).name !== "codex-team-room" || !fs.existsSync(path.join(root, "server"))) {
  throw new Error("invalid_codex_team_room_directory");
}
if (!nodeSupported()) {
  if (skipNodeInstall) throw new Error("node_20_19_or_22_12_required");
  const winget = where("winget.exe")[0];
  if (!winget) throw new Error("node_upgrade_requires_windows_app_installer");
  step("Upgrading Node.js LTS");
  let upgraded = run(winget, ["upgrade", "--id", "OpenJS.NodeJS.LTS", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent"], { allowFailure: true });
  if (upgraded.error || upgraded.status !== 0) {
    upgraded = run(winget, ["install", "--id", "OpenJS.NodeJS.LTS", "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements", "--silent"], { allowFailure: true });
  }
  const nodeCandidates = [path.join(process.env.ProgramFiles || "", "nodejs", "node.exe"), ...where("node.exe")]
    .filter((candidate, index, values) => candidate && values.indexOf(candidate) === index && fs.existsSync(candidate));
  const freshNode = nodeCandidates.find((candidate) => {
    const value = run(candidate, ["--version"], { capture: true, allowFailure: true });
    return !value.error && value.status === 0 && nodeSupported(String(value.stdout).trim().replace(/^v/, ""));
  });
  if (!freshNode) throw new Error("node_upgraded_but_not_available_sign_out_and_run_again");
  const resumed = spawnSync(freshNode, [import.meta.filename, ...rawArgs, "--skip-node-install"], { cwd: root, stdio: "inherit", windowsHide: false });
  process.exit(resumed.status ?? 1);
}
const npmCli = findNpmCli();
if (!npmCli) throw new Error("npm_cli_unavailable");
const runNpm = (npmArgs) => run(process.execPath, [npmCli, ...npmArgs]);

step("Rebuilding dependencies from package-lock.json");
runNpm(["ci", "--no-audit", "--no-fund"]);
step("Verifying the production build");
runNpm(["run", "build"]);
step("Checking release safety");
runNpm(["run", "release:check"]);

if (!skipCodexCheck) {
  step("Checking the standalone Codex CLI");
  let available = verifyCodex();
  if (!available && !skipCodexInstall) {
    runNpm(["install", "--global", "@openai/codex@latest", "--no-audit", "--no-fund"]);
    available = verifyCodex();
  }
  if (!available) throw new Error("codex_cli_could_not_be_started_run_installer_by_double_click");
  process.stdout.write("Authentication files are never inspected. A real member turn verifies sign-in after pairing.\n");
}

step("Starting and verifying the local Team Room");
const startArgs = [path.join(import.meta.dirname, "start-team-room.mjs"), `--port=${port}`];
if (args.has("--stop-after-verify")) startArgs.push("--stop-after-verify");
const startResult = run(process.execPath, startArgs, { capture: true });
const started = JSON.parse(String(startResult.stdout).trim().split(/\r?\n/).at(-1));
if (!started.ok) throw new Error("local_service_health_check_failed");

if (!noAutoStart) {
  step("Enabling recovery after Windows sign-in");
  const startup = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  if (!process.env.APPDATA || !fs.existsSync(startup)) throw new Error("windows_startup_folder_unavailable");
  const launcher = [
    "@echo off",
    `start \"\" /min \"${process.execPath}\" \"${path.join(import.meta.dirname, "start-team-room.mjs")}\" --port=${port}`,
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(startup, "Codex Team Room.cmd"), launcher, "ascii");
}

fs.mkdirSync(path.join(root, ".team-room"), { recursive: true });
fs.writeFileSync(path.join(root, ".team-room", "install-state.json"), JSON.stringify({
  installedAt: new Date().toISOString(),
  projectRoot: root,
  port,
  localUrl: `http://127.0.0.1:${port}/`,
  autoStart: !noAutoStart,
}, null, 2) + "\n", "utf8");

if (!noOpen && process.platform === "win32") {
  const opener = spawn("explorer.exe", [`http://127.0.0.1:${port}/`], { detached: true, windowsHide: false, stdio: "ignore" });
  opener.unref();
}
process.stdout.write(`\nINSTALLATION COMPLETE: http://127.0.0.1:${port}/\n`);
process.stdout.write("For private mobile access, drag CODEX_SETUP.md into Codex and approve owner-only pairing once.\n");
