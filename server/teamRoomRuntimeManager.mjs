import { EventEmitter } from "node:events";
import { getCodexRuntimeStatus, spawnCodexAppServer } from "./codexAppServerRuntime.mjs";

const MAX_EVENTS = 500;

function normalizedPath(value) {
  return String(value || "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function sameProjectPath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function optionalId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function preferredThreadId(agent) {
  return optionalId(agent?.boundThreadId) || optionalId(agent?.runtimeThreadId);
}

export class TeamRoomRuntimeManager {
  constructor({ statusProvider = getCodexRuntimeStatus, runtimeFactory = spawnCodexAppServer } = {}) {
    this.statusProvider = statusProvider;
    this.runtimeFactory = runtimeFactory;
    this.connection = null;
    this.agentById = new Map();
    this.agentByThreadId = new Map();
    this.threadByAgentId = new Map();
    this.roomByThreadId = new Map();
    this.turnContextById = new Map();
    this.pendingApprovals = new Map();
    this.writeLock = null;
    this.events = [];
    this.sequence = 0;
    this.cwd = null;
    this.roomId = null;
    this.taskId = null;
  }

  status() {
    const runtime = this.statusProvider();
    return {
      ...runtime,
      connected: Boolean(this.connection),
      cwd: this.cwd,
      roomId: this.roomId,
      taskId: this.taskId,
      agentThreads: Object.fromEntries(this.threadByAgentId),
      pendingApprovals: this.pendingApprovals.size,
      writeLock: this.writeLock,
    };
  }

  emitRoomEvent(type, payload = {}) {
    const event = {
      sequence: ++this.sequence,
      type,
      createdAt: new Date().toISOString(),
      roomId: payload.roomId ?? this.roomId,
      taskId: payload.taskId ?? this.taskId,
      ...payload,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    return event;
  }

  synchroniseAgents(agents) {
    const nextAgents = new Map((agents || []).map((agent) => [agent.id, agent]));
    for (const [agentId, threadId] of this.threadByAgentId) {
      const nextAgent = nextAgents.get(agentId);
      const requestedThreadId = preferredThreadId(nextAgent);
      if (!nextAgent || (requestedThreadId && requestedThreadId !== threadId)) {
        this.threadByAgentId.delete(agentId);
        this.agentByThreadId.delete(threadId);
        this.roomByThreadId.delete(threadId);
      }
    }
    this.agentById = nextAgents;
  }

  assertSafeToSwitch() {
    if (this.pendingApprovals.size) throw new Error("Cannot switch projects while approval is pending");
    if (this.writeLock) throw new Error("Cannot switch projects while a write lock is active");
  }

  async connect({ cwd, agents, confirmed, roomId = null, taskId = null }) {
    if (confirmed !== true) throw new Error("Real runtime connection requires explicit confirmation");
    const nextRoomId = optionalId(roomId);
    const nextTaskId = optionalId(taskId);
    if (this.connection) {
      const sameScope = sameProjectPath(this.cwd, cwd) && this.roomId === nextRoomId;
      if (sameScope) {
        this.taskId = nextTaskId;
        this.synchroniseAgents(agents);
        return this.status();
      }
      this.assertSafeToSwitch();
      this.disconnect();
    }
    const runtime = this.statusProvider();
    if (!runtime.available || !runtime.executable) throw new Error(runtime.reason || "Codex CLI is unavailable");
    this.cwd = cwd;
    this.roomId = nextRoomId;
    this.taskId = nextTaskId;
    this.synchroniseAgents(agents);
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
    this.roomByThreadId.clear();
    this.turnContextById.clear();
    this.pendingApprovals.clear();
    this.writeLock = null;
    this.emitRoomEvent("runtimeDisconnected");
    this.cwd = null;
    this.roomId = null;
    this.taskId = null;
    return this.status();
  }

  async ensureAgentThread(agentId) {
    const existing = this.threadByAgentId.get(agentId);
    if (existing) return existing;
    if (!this.connection) throw new Error("Real runtime is not connected");
    const agent = this.agentById.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const boundThreadId = preferredThreadId(agent);
    const thread = boundThreadId
      ? await this.connection.protocol.resumeAgentThread(boundThreadId, agent, this.cwd)
      : await this.connection.protocol.startAgentThread(agent, this.cwd);
    if (!thread?.id) throw new Error(`Codex did not return a thread for member ${agentId}`);
    if (boundThreadId && thread.id !== boundThreadId) {
      throw new Error(`Codex resumed an unexpected thread for member ${agentId}`);
    }
    this.threadByAgentId.set(agentId, thread.id);
    this.agentByThreadId.set(thread.id, agentId);
    this.roomByThreadId.set(thread.id, this.roomId);
    this.emitRoomEvent("agentThreadBound", {
      agentId,
      threadId: thread.id,
      model: agent.model,
      bindingMode: optionalId(agent.threadBinding) || (boundThreadId ? "existing" : "auto"),
    });
    return thread.id;
  }

  async dispatch({ text, decisions, messageId, roomId = null, taskId = null, sharedContext = null, attachments = [], executionMode = true }) {
    if (!this.connection) throw new Error("Real runtime is not connected");
    const requestedRoomId = optionalId(roomId);
    if (requestedRoomId !== null && requestedRoomId !== this.roomId) {
      throw new Error("Dispatch room does not match the connected project room");
    }
    this.taskId = optionalId(taskId) || this.taskId;
    const speakers = decisions.filter((decision) => decision.decision === "speak");
    const turns = await Promise.all(speakers.map(async (decision) => {
      const agent = this.agentById.get(decision.agentId);
      if (!agent) throw new Error(`Unknown agent: ${decision.agentId}`);
      const turnAgent = executionMode === false && agent.permission === "request-write" ? { ...agent, permission: "read-only" } : agent;
      const threadWasAlreadyBound = this.threadByAgentId.has(decision.agentId);
      const threadId = await this.ensureAgentThread(decision.agentId);
      // The current App Server protocol applies developer instructions on thread
      // start/resume rather than turn/start. A newly started/resumed thread has
      // already received them; only refresh a thread reused by a later turn.
      if (threadWasAlreadyBound && optionalId(agent.systemPrompt)) {
        const resumedThread = await this.connection.protocol.resumeAgentThread(threadId, agent, this.cwd);
        if (!resumedThread?.id || resumedThread.id !== threadId) {
          throw new Error(`Codex resumed an unexpected thread for member ${agent.id}`);
        }
      }
      const turn = await this.connection.protocol.startAgentTurn({
        threadId,
        agent: turnAgent,
        cwd: this.cwd,
        text,
        clientUserMessageId: messageId,
        sharedContext,
        attachments,
      });
      if (!turn?.id) throw new Error(`Codex did not return a turn for member ${agent.id}`);
      this.turnContextById.set(turn.id, { roomId: this.roomId, taskId: this.taskId });
      this.emitRoomEvent("turnStarted", { agentId: agent.id, threadId, turnId: turn.id, messageId });
      return { agentId: agent.id, threadId, turnId: turn.id };
    }));
    return { turns };
  }

  handleNotification(event) {
    const params = event.params || {};
    const agentId = this.agentByThreadId.get(params.threadId) || null;
    const turnId = params.turnId || params.turn?.id || null;
    const turnContext = turnId ? this.turnContextById.get(turnId) : null;
    const roomId = turnContext?.roomId ?? this.roomByThreadId.get(params.threadId) ?? this.roomId;
    const taskId = turnContext?.taskId ?? this.taskId;
    if (event.method === "item/completed" && params.item?.type === "agentMessage") {
      this.emitRoomEvent("agentMessage", { agentId, threadId: params.threadId, turnId, text: params.item.text || "", roomId, taskId });
    } else if (event.method === "turn/completed") {
      this.emitRoomEvent("turnCompleted", { agentId, threadId: params.threadId, turn: params.turn, roomId, taskId });
      if (turnId) this.turnContextById.delete(turnId);
    } else if (event.method === "item/completed" && ["commandExecution", "fileChange"].includes(params.item?.type)) {
      if (this.writeLock?.agentId === agentId) this.writeLock = null;
      this.emitRoomEvent("writeItemCompleted", { agentId, threadId: params.threadId, item: params.item, roomId, taskId });
    }
  }

  handleApproval(request) {
    const params = request.params || {};
    const agentId = this.agentByThreadId.get(params.threadId) || null;
    const turnId = params.turnId || null;
    const turnContext = turnId ? this.turnContextById.get(turnId) : null;
    const approval = {
      requestId: request.id,
      method: request.method,
      agentId,
      threadId: params.threadId,
      turnId,
      itemId: params.itemId || null,
      command: params.command || params.reason || "Codex 请求受控写入",
      cwd: params.cwd || this.cwd,
      roomId: turnContext?.roomId ?? this.roomByThreadId.get(params.threadId) ?? this.roomId,
      taskId: turnContext?.taskId ?? this.taskId,
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
