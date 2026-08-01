import { EventEmitter } from "node:events";
import { getCodexRuntimeStatus, spawnCodexAppServer } from "./codexAppServerRuntime.mjs";

const MAX_EVENTS = 500;

export class TeamRoomRuntimeManager {
  constructor({ statusProvider = getCodexRuntimeStatus, runtimeFactory = spawnCodexAppServer } = {}) {
    this.statusProvider = statusProvider;
    this.runtimeFactory = runtimeFactory;
    this.connection = null;
    this.agentById = new Map();
    this.agentByThreadId = new Map();
    this.threadByAgentId = new Map();
    this.pendingApprovals = new Map();
    this.writeLock = null;
    this.events = [];
    this.sequence = 0;
    this.cwd = null;
  }

  status() {
    const runtime = this.statusProvider();
    return {
      ...runtime,
      connected: Boolean(this.connection),
      cwd: this.cwd,
      agentThreads: Object.fromEntries(this.threadByAgentId),
      pendingApprovals: this.pendingApprovals.size,
      writeLock: this.writeLock,
    };
  }

  emitRoomEvent(type, payload = {}) {
    const event = { sequence: ++this.sequence, type, createdAt: new Date().toISOString(), ...payload };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return event;
  }

  async connect({ cwd, agents, confirmed }) {
    if (confirmed !== true) throw new Error("Real runtime connection requires explicit confirmation");
    if (this.connection) return this.status();
    const runtime = this.statusProvider();
    if (!runtime.available || !runtime.executable) throw new Error(runtime.reason || "Codex CLI is unavailable");
    this.cwd = cwd;
    this.agentById = new Map(agents.map((agent) => [agent.id, agent]));
    this.connection = this.runtimeFactory(runtime.executable);
    this.connection.protocol.on("notification", (event) => this.handleNotification(event));
    this.connection.protocol.on("approval", (request) => this.handleApproval(request));
    await this.connection.protocol.initialize();
    this.emitRoomEvent("runtimeConnected", { cwd });
    return this.status();
  }

  disconnect() {
    if (this.connection?.child && !this.connection.child.killed) this.connection.child.kill();
    this.connection = null;
    this.agentByThreadId.clear();
    this.threadByAgentId.clear();
    this.pendingApprovals.clear();
    this.writeLock = null;
    this.emitRoomEvent("runtimeDisconnected");
    return this.status();
  }

  async ensureAgentThread(agentId) {
    const existing = this.threadByAgentId.get(agentId);
    if (existing) return existing;
    if (!this.connection) throw new Error("Real runtime is not connected");
    const agent = this.agentById.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const thread = await this.connection.protocol.startAgentThread(agent, this.cwd);
    this.threadByAgentId.set(agentId, thread.id);
    this.agentByThreadId.set(thread.id, agentId);
    this.emitRoomEvent("agentThreadBound", { agentId, threadId: thread.id, model: agent.model });
    return thread.id;
  }

  async dispatch({ text, decisions, messageId }) {
    if (!this.connection) throw new Error("Real runtime is not connected");
    const speakers = decisions.filter((decision) => decision.decision === "speak");
    const turns = await Promise.all(speakers.map(async (decision) => {
      const agent = this.agentById.get(decision.agentId);
      const threadId = await this.ensureAgentThread(decision.agentId);
      const turn = await this.connection.protocol.startAgentTurn({
        threadId,
        agent,
        cwd: this.cwd,
        text,
        clientUserMessageId: messageId,
      });
      this.emitRoomEvent("turnStarted", { agentId: agent.id, threadId, turnId: turn.id, messageId });
      return { agentId: agent.id, threadId, turnId: turn.id };
    }));
    return { turns };
  }

  handleNotification(event) {
    const params = event.params || {};
    const agentId = this.agentByThreadId.get(params.threadId) || null;
    if (event.method === "item/completed" && params.item?.type === "agentMessage") {
      this.emitRoomEvent("agentMessage", { agentId, threadId: params.threadId, turnId: params.turnId, text: params.item.text || "" });
    } else if (event.method === "turn/completed") {
      this.emitRoomEvent("turnCompleted", { agentId, threadId: params.threadId, turn: params.turn });
    } else if (event.method === "item/completed" && ["commandExecution", "fileChange"].includes(params.item?.type)) {
      if (this.writeLock?.agentId === agentId) this.writeLock = null;
      this.emitRoomEvent("writeItemCompleted", { agentId, threadId: params.threadId, item: params.item });
    }
  }

  handleApproval(request) {
    const params = request.params || {};
    const agentId = this.agentByThreadId.get(params.threadId) || null;
    const approval = {
      requestId: request.id,
      method: request.method,
      agentId,
      threadId: params.threadId,
      turnId: params.turnId || null,
      itemId: params.itemId || null,
      command: params.command || params.reason || "Codex 请求受控写入",
      cwd: params.cwd || this.cwd,
    };
    this.pendingApprovals.set(request.id, approval);
    this.emitRoomEvent("approvalRequested", approval);
  }

  resolveApproval({ requestId, decision }) {
    if (!this.connection) throw new Error("Real runtime is not connected");
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) throw new Error("Approval request not found");
    const agent = this.agentById.get(approval.agentId);
    if (decision === "accept") {
      if (agent?.permission !== "request-write") throw new Error("This member has no write permission");
      if (this.writeLock && this.writeLock.agentId !== approval.agentId) {
        throw new Error(`Write lock is held by ${this.writeLock.agentId}`);
      }
      this.writeLock = { agentId: approval.agentId, requestId, acquiredAt: new Date().toISOString() };
    }
    this.connection.protocol.resolveApproval(requestId, decision);
    this.pendingApprovals.delete(requestId);
    this.emitRoomEvent("approvalResolved", { ...approval, decision });
    return { approval, writeLock: this.writeLock };
  }

  listEvents(after = 0) {
    return this.events.filter((event) => event.sequence > after);
  }
}

export const teamRoomRuntime = new TeamRoomRuntimeManager();
