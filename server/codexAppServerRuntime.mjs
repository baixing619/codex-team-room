import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { buildTurnInput } from "./sharedContext.mjs";

const SAFE_APPROVAL_DECISIONS = new Set(["accept", "decline", "cancel"]);

export class JsonLineRpcClient extends EventEmitter {
  constructor({ send }) {
    super();
    this.sendLine = send;
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.sendLine(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  notify(method, params = {}) {
    this.sendLine(JSON.stringify({ method, params }));
  }

  respond(id, result) {
    if (!this.serverRequests.has(id)) throw new Error(`Unknown server request: ${id}`);
    this.serverRequests.delete(id);
    this.sendLine(JSON.stringify({ id, result }));
  }

  receive(message) {
    const value = typeof message === "string" ? JSON.parse(message) : message;
    if (value.id !== undefined && !value.method) {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id);
      if (value.error) pending.reject(new Error(value.error.message || `RPC ${pending.method} failed`));
      else pending.resolve(value.result);
      return;
    }
    if (value.id !== undefined && value.method) {
      this.serverRequests.set(value.id, value);
      this.emit("approval", value);
      return;
    }
    if (value.method) this.emit("notification", value);
  }

  close(error = new Error("Codex App Server connection closed")) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.serverRequests.clear();
  }
}

function threadSandboxForAgent(agent) {
  return agent.permission === "request-write" ? "workspace-write" : "read-only";
}

function turnSandboxForAgent(agent) {
  return agent.permission === "request-write" ? "workspaceWrite" : "readOnly";
}

function developerInstructionsForAgent(agent) {
  const value = typeof agent?.systemPrompt === "string" ? agent.systemPrompt.trim() : "";
  return value || null;
}

function isCoordinatorAgent(agent) {
  return agent?.permission === "coordinate";
}

function createCoordinatorIsolationDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-coordinator-"));
}

export class CodexAppServerProtocol extends EventEmitter {
  constructor(rpc) {
    super();
    this.rpc = rpc;
    this.initialized = false;
    this.coordinatorIsolationByThreadId = new Map();
    this.coordinatorIsolationDirectories = new Set();
    rpc.on("approval", (request) => this.emit("approval", request));
    rpc.on("notification", (event) => this.emit("notification", event));
  }

  async initialize() {
    if (this.initialized) return;
    await this.rpc.request("initialize", {
      clientInfo: { name: "codex-team-room", title: "Codex Team Room", version: "0.3.0" },
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify("initialized", {});
    this.initialized = true;
  }

  async startAgentThread(agent, cwd) {
    await this.initialize();
    const developerInstructions = developerInstructionsForAgent(agent);
    const coordinatorIsolation = isCoordinatorAgent(agent) ? createCoordinatorIsolationDirectory() : null;
    if (coordinatorIsolation) this.coordinatorIsolationDirectories.add(coordinatorIsolation);
    let result;
    try {
      result = await this.rpc.request("thread/start", {
        cwd: coordinatorIsolation || cwd,
        model: agent.model,
        approvalPolicy: "untrusted",
        sandbox: threadSandboxForAgent(agent),
        ...(coordinatorIsolation ? { runtimeWorkspaceRoots: [], environments: [], selectedCapabilityRoots: [] } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      });
    } catch (error) {
      if (coordinatorIsolation) {
        this.coordinatorIsolationDirectories.delete(coordinatorIsolation);
        try { fs.rmSync(coordinatorIsolation, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
    if (coordinatorIsolation && result.thread?.id) this.coordinatorIsolationByThreadId.set(result.thread.id, coordinatorIsolation);
    return result.thread;
  }

  async resumeAgentThread(threadId, agent, cwd) {
    await this.initialize();
    const developerInstructions = developerInstructionsForAgent(agent);
    let coordinatorIsolation = null;
    if (isCoordinatorAgent(agent)) {
      coordinatorIsolation = this.coordinatorIsolationByThreadId.get(threadId) || createCoordinatorIsolationDirectory();
      this.coordinatorIsolationDirectories.add(coordinatorIsolation);
      this.coordinatorIsolationByThreadId.set(threadId, coordinatorIsolation);
    }
    const result = await this.rpc.request("thread/resume", {
      threadId,
      cwd: coordinatorIsolation || cwd,
      model: agent.model,
      approvalPolicy: "untrusted",
      sandbox: threadSandboxForAgent(agent),
      ...(coordinatorIsolation ? { runtimeWorkspaceRoots: [] } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    });
    return result.thread;
  }

  async startAgentTurn({ threadId, agent, cwd, text, clientUserMessageId, sharedContext, attachments }) {
    await this.initialize();
    let coordinatorIsolation = null;
    if (isCoordinatorAgent(agent)) {
      coordinatorIsolation = this.coordinatorIsolationByThreadId.get(threadId) || createCoordinatorIsolationDirectory();
      this.coordinatorIsolationDirectories.add(coordinatorIsolation);
      this.coordinatorIsolationByThreadId.set(threadId, coordinatorIsolation);
    }
    const result = await this.rpc.request("turn/start", {
      threadId,
      clientUserMessageId,
      input: buildTurnInput({ text, sharedContext, attachments }),
      cwd: coordinatorIsolation || cwd,
      model: agent.model,
      effort: agent.reasoning,
      approvalPolicy: "untrusted",
      sandboxPolicy: turnSandboxForAgent(agent) === "workspaceWrite"
        ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
        : { type: "readOnly", networkAccess: false },
      ...(coordinatorIsolation ? { runtimeWorkspaceRoots: [], environments: [] } : {}),
    });
    return result.turn;
  }

  async interruptAgentTurn(threadId, turnId) {
    await this.initialize();
    return this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  dispose() {
    this.coordinatorIsolationByThreadId.clear();
    for (const directory of this.coordinatorIsolationDirectories) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    }
    this.coordinatorIsolationDirectories.clear();
  }

  resolveApproval(requestId, decision) {
    if (!SAFE_APPROVAL_DECISIONS.has(decision)) {
      throw new Error("Only one-time accept, decline, or cancel decisions are allowed");
    }
    this.rpc.respond(requestId, { decision });
  }
}

export function npmCodexBinaryCandidate({ appData = process.env.APPDATA, arch = process.arch } = {}) {
  const platformPackage = arch === "arm64" ? "codex-win32-arm64" : arch === "x64" ? "codex-win32-x64" : null;
  const rustTarget = arch === "arm64" ? "aarch64-pc-windows-msvc" : arch === "x64" ? "x86_64-pc-windows-msvc" : null;
  if (!appData || !platformPackage || !rustTarget) return null;
  return path.join(
    appData,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    platformPackage,
    "vendor",
    rustTarget,
    "bin",
    "codex.exe",
  );
}

function npmCodexBinaryFromShim(shimPath) {
  if (process.platform !== "win32" || !/\.(?:cmd|ps1)$/i.test(shimPath)) return null;
  const appData = path.dirname(path.dirname(shimPath));
  return npmCodexBinaryCandidate({ appData });
}

function whereCandidates() {
  const candidates = [];
  const explicit = process.env.CODEX_TEAM_ROOM_CODEX_BIN;
  if (explicit) candidates.push(path.resolve(explicit));
  if (process.platform === "win32") {
    const npmBinary = npmCodexBinaryCandidate();
    if (npmBinary) candidates.push(npmBinary);
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, ["codex"], { encoding: "utf8", timeout: 2500, windowsHide: true });
  if (result.status === 0) {
    for (const line of String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      if (process.platform !== "win32" || line.toLowerCase().endsWith(".exe")) candidates.push(line);
      const npmBinary = npmCodexBinaryFromShim(line);
      if (npmBinary) candidates.push(npmBinary);
    }
  }
  return Array.from(new Set(candidates));
}

export function getCodexRuntimeStatus() {
  for (const candidate of whereCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const version = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 3500, windowsHide: true });
    if (version.status === 0) {
      return {
        available: true,
        executable: candidate,
        version: String(version.stdout || version.stderr || "").trim(),
        transport: "stdio",
      };
    }
  }
  return {
    available: false,
    executable: null,
    version: null,
    transport: "stdio",
    reason: "未找到可独立启动的 Codex CLI；历史会话仍可只读接入。",
  };
}

export function spawnCodexAppServer(executable) {
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) {
    throw new Error("Codex executable must be an existing absolute path");
  }
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rpc = new JsonLineRpcClient({ send: (line) => child.stdin.write(`${line}\n`) });
  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => {
    try {
      rpc.receive(line);
    } catch (error) {
      rpc.emit("protocolError", error);
    }
  });
  child.on("exit", (code) => rpc.close(new Error(`Codex App Server exited with code ${code}`)));
  return { child, rpc, protocol: new CodexAppServerProtocol(rpc) };
}
