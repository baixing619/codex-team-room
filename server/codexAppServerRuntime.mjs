import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

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

function sandboxForAgent(agent) {
  return agent.permission === "request-write" ? "workspaceWrite" : "readOnly";
}

export class CodexAppServerProtocol extends EventEmitter {
  constructor(rpc) {
    super();
    this.rpc = rpc;
    this.initialized = false;
    rpc.on("approval", (request) => this.emit("approval", request));
    rpc.on("notification", (event) => this.emit("notification", event));
  }

  async initialize() {
    if (this.initialized) return;
    await this.rpc.request("initialize", {
      clientInfo: { name: "codex-team-room", title: "Codex Team Room", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.rpc.notify("initialized", {});
    this.initialized = true;
  }

  async startAgentThread(agent, cwd) {
    await this.initialize();
    const result = await this.rpc.request("thread/start", {
      cwd,
      model: agent.model,
      approvalPolicy: "unlessTrusted",
      sandbox: sandboxForAgent(agent),
    });
    return result.thread;
  }

  async resumeAgentThread(threadId) {
    await this.initialize();
    const result = await this.rpc.request("thread/resume", { threadId });
    return result.thread;
  }

  async startAgentTurn({ threadId, agent, cwd, text, clientUserMessageId }) {
    await this.initialize();
    const result = await this.rpc.request("turn/start", {
      threadId,
      clientUserMessageId,
      input: [{ type: "text", text }],
      cwd,
      model: agent.model,
      effort: agent.reasoning,
      approvalPolicy: "unlessTrusted",
      sandboxPolicy: sandboxForAgent(agent) === "workspaceWrite"
        ? { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false }
        : { type: "readOnly", networkAccess: false },
    });
    return result.turn;
  }

  resolveApproval(requestId, decision) {
    if (!SAFE_APPROVAL_DECISIONS.has(decision)) {
      throw new Error("Only one-time accept, decline, or cancel decisions are allowed");
    }
    this.rpc.respond(requestId, { decision });
  }
}

function whereCandidates() {
  const candidates = [];
  const explicit = process.env.CODEX_TEAM_ROOM_CODEX_BIN;
  if (explicit) candidates.push(path.resolve(explicit));
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(finder, ["codex"], { encoding: "utf8", timeout: 2500, windowsHide: true });
  if (result.status === 0) {
    for (const line of String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      if (process.platform !== "win32" || line.toLowerCase().endsWith(".exe")) candidates.push(line);
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
