import { EventEmitter } from "node:events";
import { getCodexRuntimeStatus, spawnCodexAppServer } from "./codexAppServerRuntime.mjs";
import { decideParticipation, isAgentMentioned, isBroadcastRequest } from "../src/lib/participation.js";
import { selectSharedContextForAgent } from "./sharedContext.mjs";
import { approvalIdentity, classifyApprovalRequest } from "../src/lib/approvalLifecycle.js";
import { formatTaskResult, isCoordinatorOnlyRequest, parseTaskAssignments, stripTaskAssignmentBlocks, TASK_ASSIGNMENT_START, validateTaskAssignment } from "../src/lib/taskAssignments.js";

const MAX_EVENTS = 500;
function coordinatorInitialProtocol(record, agents) {
  const targets = (agents || [])
    .filter((agent) => agent?.id && agent.id !== record?.coordinatorAgentId)
    .map((agent) => `${agent.id}/${agent.name || agent.role || "成员"}`)
    .join(", ");
  return `[TEAM_ROOM_COORDINATOR_PROTOCOL_V1] 你是纯协调总控：只做澄清、分析、拆解、规划、委派和汇总，严禁亲自调用命令、读取项目文件、修改文件或执行本机工具。需要证据时委派成员。真实委派只能输出最多4个严格 TEAM_ROOM_TASK_ASSIGNMENT_V1 块；本轮 parentTaskId=${record?.id || ""}，depth=${Number(record?.depth || 0) + 1}，可分派 targetAgentId=${targets || "无"}。普通房间任务的 visibility 使用 room，让成员回复进入团队消息并形成后续共享上下文；只有用户明确只让总控回复或其他人不要发言时才使用 coordinator-only。每个 assignmentId 必须在本轮唯一，并且每个块必须包含 assignmentId、parentTaskId、targetAgentId、objective、acceptanceCriteria、visibility、depth；普通 @文字或承诺不算委派。`;
}
const COORDINATOR_FINAL_SUMMARY_PROTOCOL = "[TEAM_ROOM_FINAL_SUMMARY_PROTOCOL_V1] 只汇总已回流的委派结果，严禁调用工具、读写文件或再次输出 TEAM_ROOM_TASK_ASSIGNMENT_V1。";

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

function isTurnSuccessful(turn) {
  const status = optionalId(turn?.status)?.toLowerCase();
  return !status || ["completed", "succeeded", "success"].includes(status);
}

function safeTaskError(error) {
  return String(error instanceof Error ? error.message : error || "task_failed")
    .replace(/[A-Za-z]:[\\/][^\s\]\)\}>,;]+/g, "[本机路径已隐藏]")
    .replace(/(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]+/gi, "[凭据已隐藏]")
    .slice(0, 600);
}

export class TeamRoomRuntimeManager {
  constructor({ statusProvider = getCodexRuntimeStatus, runtimeFactory = spawnCodexAppServer, approvalTimeoutMs = 120_000 } = {}) {
    this.statusProvider = statusProvider;
    this.runtimeFactory = runtimeFactory;
    this.connection = null;
    this.agentById = new Map();
    this.agentByThreadId = new Map();
    this.threadByAgentId = new Map();
    this.roomByThreadId = new Map();
    this.turnContextById = new Map();
    this.turnMessagesById = new Map();
    this.activeTurnByThreadId = new Map();
    this.turnQueuesByThreadId = new Map();
    this.threadStartPromises = new Map();
    this.taskRecords = new Map();
    this.assignmentById = new Map();
    this.assignmentSourceTargets = new Set();
    this.taskWaiters = new Map();
    this.pendingApprovals = new Map();
    this.approvalTimers = new Map();
    this.approvalTimeoutMs = Math.max(1_000, Number(approvalTimeoutMs) || 120_000);
    this.writeLock = null;
    this.events = [];
    this.sequence = 0;
    this.cwd = null;
    this.roomId = null;
    this.taskId = null;
  }

  status() {
    this.expireStaleApprovals();
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

  coordinatorAgent() {
    return [...this.agentById.values()].find((agent) => agent.id === "coordinator" || agent.role === "总控" || agent.name === "总控") || null;
  }

  ensureTaskRecord({ taskId, roomId = this.roomId, text = "", executionMode = true, coordinatorAgentId = null } = {}) {
    const id = optionalId(taskId) || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = this.taskRecords.get(id);
    if (existing) return existing;
    const coordinator = coordinatorAgentId || this.coordinatorAgent()?.id || null;
    const record = {
      id,
      roomId,
      depth: 0,
      parentTaskId: null,
      rootTaskId: id,
      coordinatorAgentId: coordinator,
      agentPath: coordinator ? [coordinator] : [],
      executionMode: executionMode !== false,
      visibility: isCoordinatorOnlyRequest(text) ? "coordinator-only" : "room",
      state: "running",
      dispatchStarted: false,
      coordinatorTurnId: null,
      coordinatorThreadId: null,
      pendingTurnIds: new Set(),
      turnIds: new Set(),
      pendingAssignments: new Set(),
      assignmentResults: new Map(),
      failedAssignments: new Set(),
      finalSummaryStarted: false,
      finalSummaryCompleted: false,
      delegationCount: 0,
      terminalError: null,
      createdAt: new Date().toISOString(),
    };
    this.taskRecords.set(id, record);
    this.emitRoomEvent("taskStarted", { taskId: id, status: "running", public: true });
    return record;
  }

  taskStatusEvent(record, type, error = null) {
    if (!record) return;
    this.emitRoomEvent(type, {
      taskId: record.id,
      eventId: `${record.id}:${type}`,
      status: type === "taskCompleted" ? "succeeded" : type === "taskFailed" ? "failed" : type === "taskWaitingApproval" ? "waiting_approval" : "running",
      error: error ? safeTaskError(error) : null,
      public: true,
    });
  }

  resolveTaskWaiters(record) {
    if (!record || !["succeeded", "failed"].includes(record.state)) return;
    const waiters = this.taskWaiters.get(record.id) || [];
    this.taskWaiters.delete(record.id);
    for (const resolve of waiters) resolve({ taskId: record.id, status: record.state, error: record.terminalError });
  }

  finishTask(record, status, error = null) {
    if (!record || ["succeeded", "failed"].includes(record.state)) return false;
    record.state = status === "succeeded" ? "succeeded" : "failed";
    record.terminalError = error ? safeTaskError(error) : null;
    this.taskStatusEvent(record, record.state === "succeeded" ? "taskCompleted" : "taskFailed", record.terminalError);
    this.resolveTaskWaiters(record);
    return true;
  }

  failTask(record, error) {
    if (!record) return;
    record.pendingAssignments.clear();
    record.pendingTurnIds.clear();
    this.finishTask(record, "failed", error);
  }

  waitForTask(taskId) {
    const record = this.taskRecords.get(taskId);
    if (!record) return Promise.resolve({ taskId, status: "succeeded", error: null });
    if (["succeeded", "failed"].includes(record.state)) return Promise.resolve({ taskId, status: record.state, error: record.terminalError });
    return new Promise((resolve) => {
      const waiters = this.taskWaiters.get(taskId) || [];
      waiters.push(resolve);
      this.taskWaiters.set(taskId, waiters);
    });
  }

  maybeFinishTask(record) {
    if (!record || !record.dispatchStarted || record.pendingTurnIds.size || record.pendingAssignments.size) return;
    if (record.assignmentResults.size && !record.finalSummaryStarted) {
      void this.startFinalSummary(record);
      return;
    }
    if (record.finalSummaryStarted && !record.finalSummaryCompleted) return;
    this.finishTask(record, "succeeded");
  }

  recordAssignmentFailure(record, assignment, reason, sourceTurnId) {
    const assignmentId = optionalId(assignment?.assignmentId) || `rejected-${sourceTurnId}-${record.assignmentResults.size + 1}`;
    record.assignmentResults.set(assignmentId, {
      assignmentId,
      targetAgentId: optionalId(assignment?.targetAgentId) || null,
      status: "failed",
      summary: safeTaskError(reason),
      sourceTurnId,
    });
    record.failedAssignments.add(assignmentId);
  }

  registerTurn(record, turn, context) {
    if (!record || !turn?.id) return;
    record.pendingTurnIds.add(turn.id);
    record.turnIds.add(turn.id);
    this.turnContextById.set(turn.id, { roomId: record.roomId, taskId: record.id, ...context });
    this.turnMessagesById.set(turn.id, []);
  }

  clearThreadActivity(threadId, turnId) {
    if (this.activeTurnByThreadId.get(threadId) === turnId) this.activeTurnByThreadId.delete(threadId);
    const queue = this.turnQueuesByThreadId.get(threadId);
    if (queue?.length) {
      const next = queue.shift();
      if (!queue.length) this.turnQueuesByThreadId.delete(threadId);
      this.startQueuedTurn(threadId, next);
    }
  }

  startQueuedTurn(threadId, queued) {
    this.startTurnNow(threadId, queued.descriptor)
      .then(queued.resolve)
      .catch(queued.reject);
  }

  async startTurnNow(threadId, descriptor) {
    const agent = this.agentById.get(descriptor.agentId);
    if (!agent) throw new Error(`Unknown agent: ${descriptor.agentId}`);
    const threadWasAlreadyBound = descriptor.threadWasAlreadyBound === true;
    if (threadWasAlreadyBound && optionalId(agent.systemPrompt)) {
      const resumedThread = await this.connection.protocol.resumeAgentThread(threadId, agent, this.cwd);
      if (!resumedThread?.id || resumedThread.id !== threadId) throw new Error(`Codex resumed an unexpected thread for member ${agent.id}`);
    }
    const turnAgent = descriptor.forceReadOnly || (descriptor.executionMode === false && agent.permission === "request-write")
      ? { ...agent, permission: "read-only" }
      : agent;
    let turnText = descriptor.text;
    if (agent.id === descriptor.taskRecord?.coordinatorAgentId && descriptor.kind === "initial") turnText = `${turnText}\n\n${coordinatorInitialProtocol(descriptor.taskRecord, [...this.agentById.values()])}`;
    if (agent.id === descriptor.taskRecord?.coordinatorAgentId && descriptor.kind === "finalSummary") turnText = `${turnText}\n\n${COORDINATOR_FINAL_SUMMARY_PROTOCOL}`;
    const turn = await this.connection.protocol.startAgentTurn({
      threadId,
      agent: turnAgent,
      cwd: this.cwd,
      text: turnText,
      clientUserMessageId: descriptor.messageId,
      sharedContext: selectSharedContextForAgent(descriptor.sharedContext, agent.id),
      attachments: descriptor.attachments || [],
    });
    if (!turn?.id) throw new Error(`Codex did not return a turn for member ${agent.id}`);
    this.activeTurnByThreadId.set(threadId, turn.id);
    this.registerTurn(descriptor.taskRecord, turn, {
      agentId: agent.id,
      threadId,
      kind: descriptor.kind || "initial",
      public: descriptor.public !== false,
      internal: descriptor.internal === true,
        assignment: descriptor.assignment || null,
        resultStatus: descriptor.resultStatus || null,
        resultSummary: descriptor.resultSummary || null,
        resultSourceTurnId: descriptor.resultSourceTurnId || null,
        resultReturn: descriptor.kind === "resultReturn",
    });
    if (agent.id === descriptor.taskRecord?.coordinatorAgentId && descriptor.kind !== "resultReturn") {
      descriptor.taskRecord.coordinatorTurnId = turn.id;
      descriptor.taskRecord.coordinatorThreadId = threadId;
    }
    this.emitRoomEvent("turnStarted", {
      agentId: agent.id,
      threadId,
      turnId: turn.id,
      messageId: descriptor.messageId,
      taskId: descriptor.taskRecord?.id || this.taskId,
      public: descriptor.public !== false,
      internal: descriptor.internal === true,
      turnKind: descriptor.kind || "initial",
      assignmentId: descriptor.assignment?.assignmentId || null,
    });
    return { agentId: agent.id, threadId, turnId: turn.id, taskId: descriptor.taskRecord?.id || this.taskId };
  }

  async startTurnForAgent(descriptor, { queue = false } = {}) {
    descriptor = { ...descriptor, threadWasAlreadyBound: this.threadByAgentId.has(descriptor.agentId) };
    const threadId = await this.ensureAgentThread(descriptor.agentId);
    const active = this.activeTurnByThreadId.get(threadId);
    if (active) {
      if (!queue) throw new Error(`agent_thread_busy:${descriptor.agentId}`);
      return new Promise((resolve, reject) => {
        const entries = this.turnQueuesByThreadId.get(threadId) || [];
        entries.push({ descriptor, resolve, reject });
        this.turnQueuesByThreadId.set(threadId, entries);
      });
    }
    try {
      return await this.startTurnNow(threadId, descriptor);
    } catch (error) {
      this.clearThreadActivity(threadId, null);
      throw error;
    }
  }

  async createResultReturn(record, assignment, status, summary, sourceTurnId) {
    if (!this.connection || ["succeeded", "failed"].includes(record.state)) return;
    const coordinator = this.agentById.get(record.coordinatorAgentId);
    if (!coordinator) return this.failTask(record, "coordinator_not_found");
    const resultText = formatTaskResult({
      assignmentId: assignment.assignmentId,
      parentTaskId: assignment.parentTaskId,
      targetAgentId: assignment.targetAgentId,
      sourceTurnId,
      status,
      summary,
      acceptanceCriteria: assignment.acceptanceCriteria,
    });
    try {
      await this.startTurnForAgent({
        taskRecord: record,
        agentId: coordinator.id,
        text: `以下是内部委派结果，只用于更新当前项目判断，不要再次创建委派：\n${resultText}`,
        messageId: `result-${assignment.assignmentId}`,
        sharedContext: null,
        executionMode: record.executionMode,
        forceReadOnly: record.executionMode === false,
        kind: "resultReturn",
        public: false,
        internal: true,
         assignment,
         resultStatus: status,
         resultSummary: summary,
         resultSourceTurnId: sourceTurnId,
       }, { queue: true });
    } catch (error) {
      this.failTask(record, `result_return_failed:${error.message}`);
    }
  }

  async startFinalSummary(record) {
    if (!record || record.finalSummaryStarted || record.pendingAssignments.size || !record.assignmentResults.size) return false;
    record.finalSummaryStarted = true;
    const results = [...record.assignmentResults.values()].map((result) => ({
      assignmentId: result.assignmentId,
      targetAgentId: result.targetAgentId,
      status: result.status,
      summary: result.summary,
      sourceTurnId: result.sourceTurnId,
    }));
    const resultText = results.map((result) => JSON.stringify(result)).join("\n");
    try {
      await this.startTurnForAgent({
        taskRecord: record,
        agentId: record.coordinatorAgentId,
        text: `以下是本轮真实委派的全部结果。只做最终汇总，不得执行命令、读写文件或创建新的 TEAM_ROOM_TASK_ASSIGNMENT_V1：\n${resultText}`,
        messageId: `summary-${record.id}`,
        sharedContext: null,
        executionMode: record.executionMode,
        forceReadOnly: true,
        kind: "finalSummary",
        public: true,
        internal: false,
      }, { queue: true });
      return true;
    } catch (error) {
      this.failTask(record, `final_summary_failed:${error.message}`);
      return false;
    }
  }

  async spawnAssignment(record, assignment, sourceTurnId, sourceThreadId) {
    const validation = validateTaskAssignment({
      assignment,
      coordinatorAgentId: record.coordinatorAgentId,
      sourceRoomId: record.roomId,
      sourceTurnId,
      sourceThreadId,
      parentTask: record,
      agents: [...this.agentById.values()],
      assignmentsById: this.assignmentById,
      sourceTargets: this.assignmentSourceTargets,
    });
    if (!validation.ok) {
      this.emitRoomEvent("taskAssignmentRejected", { taskId: record.id, reason: validation.reason, assignmentId: assignment?.assignmentId || null, public: true });
      this.recordAssignmentFailure(record, assignment, validation.reason, sourceTurnId);
      return false;
    }
    const target = validation.target;
    if (target.threadBinding === "existing" && !optionalId(target.boundThreadId)) {
      this.emitRoomEvent("taskAssignmentRejected", { taskId: record.id, reason: "assignment_thread_mismatch", assignmentId: assignment.assignmentId, public: true });
      this.recordAssignmentFailure(record, assignment, "assignment_thread_mismatch", sourceTurnId);
      return false;
    }
    this.assignmentById.set(assignment.assignmentId, { ...assignment, sourceTurnId, sourceThreadId, roomId: record.roomId });
    this.assignmentSourceTargets.add(`${sourceTurnId}:${assignment.targetAgentId}`);
    record.delegationCount += 1;
    record.pendingAssignments.add(assignment.assignmentId);
    const child = {
      ...record,
      id: assignment.assignmentId,
      parentTaskId: record.id,
      depth: assignment.depth,
      rootTaskId: record.rootTaskId,
      agentPath: [...(record.agentPath || []), target.id],
      pendingTurnIds: record.pendingTurnIds,
      turnIds: record.turnIds,
      pendingAssignments: record.pendingAssignments,
      delegationCount: 0,
    };
    const criteriaText = assignment.acceptanceCriteria.map((item) => `- ${item}`).join("\n");
    try {
      await this.startTurnForAgent({
        taskRecord: record,
        agentId: target.id,
        text: `你收到当前项目总控的真实委派。\n目标：${assignment.objective}\n验收标准：\n${criteriaText}\n完成后直接报告结果；不要创建新的委派块。`,
        messageId: `assignment-${assignment.assignmentId}`,
        sharedContext: null,
        executionMode: record.executionMode,
        forceReadOnly: record.executionMode === false,
        kind: "delegatedTarget",
        public: assignment.visibility === "room" && record.visibility !== "coordinator-only",
        internal: assignment.visibility !== "room" || record.visibility === "coordinator-only",
        assignment,
      }, { queue: true });
      return true;
    } catch (error) {
      record.pendingAssignments.delete(assignment.assignmentId);
      this.emitRoomEvent("taskDelegationFailed", { taskId: record.id, assignmentId: assignment.assignmentId, targetAgentId: target.id, error: safeTaskError(error), public: true });
      void this.createResultReturn(record, assignment, "failed", safeTaskError(error), sourceTurnId);
      return false;
    }
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
    const roomId = this.roomId;
    const taskId = this.taskId;
    for (const record of this.taskRecords.values()) {
      if (record.roomId === roomId && !["succeeded", "failed"].includes(record.state)) this.failTask(record, "runtime_disconnected");
    }
    for (const approval of this.pendingApprovals.values()) {
      this.emitRoomEvent("approvalFailed", { ...approval, error: "runtime_disconnected", roomId, taskId });
    }
    if (this.connection?.child && !this.connection.child.killed) this.connection.child.kill();
    this.connection = null;
    this.agentByThreadId.clear();
    this.threadByAgentId.clear();
    this.roomByThreadId.clear();
    this.turnContextById.clear();
    this.turnMessagesById.clear();
    this.activeTurnByThreadId.clear();
    this.turnQueuesByThreadId.clear();
    this.threadStartPromises.clear();
    this.pendingApprovals.clear();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.writeLock = null;
    this.emitRoomEvent("runtimeDisconnected", { roomId, taskId, error: "runtime_disconnected" });
    this.cwd = null;
    this.roomId = null;
    this.taskId = null;
    return this.status();
  }

  async ensureAgentThread(agentId) {
    const existing = this.threadByAgentId.get(agentId);
    if (existing) return existing;
    const pending = this.threadStartPromises.get(agentId);
    if (pending) return pending;
    if (!this.connection) throw new Error("Real runtime is not connected");
    const agent = this.agentById.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const boundThreadId = preferredThreadId(agent);
    const promise = (async () => {
      const thread = boundThreadId
        ? await this.connection.protocol.resumeAgentThread(boundThreadId, agent, this.cwd)
        : await this.connection.protocol.startAgentThread(agent, this.cwd);
      if (!thread?.id) throw new Error(`Codex did not return a thread for member ${agentId}`);
      if (boundThreadId && thread.id !== boundThreadId) throw new Error(`Codex resumed an unexpected thread for member ${agentId}`);
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
    })();
    this.threadStartPromises.set(agentId, promise);
    try {
      return await promise;
    } finally {
      if (this.threadStartPromises.get(agentId) === promise) this.threadStartPromises.delete(agentId);
    }
  }

  async dispatch({ text, decisions, messageId, roomId = null, taskId = null, sharedContext = null, attachments = [], executionMode = true }) {
    if (!this.connection) throw new Error("Real runtime is not connected");
    const requestedRoomId = optionalId(roomId);
    if (requestedRoomId !== null && requestedRoomId !== this.roomId) {
      throw new Error("Dispatch room does not match the connected project room");
    }
    this.taskId = optionalId(taskId) || this.taskId;
    const taskRecord = this.ensureTaskRecord({ taskId: this.taskId || messageId, roomId: this.roomId, text, executionMode });
    // Re-apply explicit mentions at the runtime boundary. This protects remote
    // tasks and older clients from a stale participation decision: a named
    // member must be dispatched on its own bound thread even when its normal
    // strategy would be silent. Unmentioned members retain the supplied
    // participation decisions.
    const broadcast = isBroadcastRequest(text);
    const explicitDecisions = decideParticipation(text, [...this.agentById.values()])
      .filter((decision) => decision.decision === "speak" && (broadcast || isAgentMentioned(text, this.agentById.get(decision.agentId))));
    const explicitByAgentId = new Map(explicitDecisions.map((decision) => [decision.agentId, decision]));
    const suppliedDecisions = Array.isArray(decisions) ? decisions : [];
    const effectiveDecisions = suppliedDecisions.map((decision) => explicitByAgentId.has(decision.agentId)
      ? { ...decision, ...explicitByAgentId.get(decision.agentId), decision: "speak" }
      : decision);
    for (const decision of explicitDecisions) {
      if (!effectiveDecisions.some((item) => item.agentId === decision.agentId)) effectiveDecisions.push(decision);
    }
    const speakers = [];
    const seen = new Set();
    for (const decision of effectiveDecisions) {
      if (decision.decision !== "speak" || seen.has(decision.agentId)) continue;
      seen.add(decision.agentId);
      speakers.push(decision);
    }
    taskRecord.dispatchStarted = true;
    const turns = await Promise.all(speakers.map((decision) => {
      if (!this.agentById.has(decision.agentId)) return Promise.reject(new Error(`Unknown agent: ${decision.agentId}`));
      return this.startTurnForAgent({
        taskRecord,
        agentId: decision.agentId,
        text,
        messageId,
        sharedContext,
        attachments,
        executionMode,
        kind: "initial",
        public: decision.agentId === taskRecord.coordinatorAgentId || taskRecord.visibility === "room",
        internal: decision.agentId !== taskRecord.coordinatorAgentId && taskRecord.visibility !== "room",
      }, { queue: false });
    }));
    this.maybeFinishTask(taskRecord);
    return { turns };
  }

  async processCompletedTurn(turnId, turn, context, finalText) {
    const record = context?.taskId ? this.taskRecords.get(context.taskId) : null;
    if (!record || context.completed) return;
    context.completed = true;
    record.pendingTurnIds.delete(turnId);
    this.turnMessagesById.delete(turnId);
    this.turnContextById.delete(turnId);
    this.clearThreadActivity(context.threadId, turnId);
    const succeeded = isTurnSuccessful(turn);

    if (context.kind === "delegatedTarget" && context.assignment) {
      if (succeeded) {
        void this.createResultReturn(record, context.assignment, "succeeded", finalText, turnId);
      } else {
        this.emitRoomEvent("taskDelegationFailed", { taskId: record.id, assignmentId: context.assignment.assignmentId, targetAgentId: context.agentId, error: safeTaskError(turn?.error || turn?.status || "target_turn_failed"), public: true });
        void this.createResultReturn(record, context.assignment, "failed", safeTaskError(turn?.error || turn?.status || "target_turn_failed"), turnId);
      }
    } else if (context.kind === "resultReturn" && context.assignment) {
      record.pendingAssignments.delete(context.assignment.assignmentId);
      const resultStatus = context.resultStatus === "failed" || !succeeded ? "failed" : "succeeded";
      const resultSummary = context.resultSummary || (succeeded ? finalText : safeTaskError(turn?.error || turn?.status || "result_return_failed"));
      record.assignmentResults.set(context.assignment.assignmentId, {
        assignmentId: context.assignment.assignmentId,
        targetAgentId: context.assignment.targetAgentId,
        status: resultStatus,
        summary: resultSummary,
        sourceTurnId: context.resultSourceTurnId || turnId,
      });
      if (resultStatus === "failed") record.failedAssignments.add(context.assignment.assignmentId);
      await this.startFinalSummary(record);
      if (!succeeded && !record.finalSummaryStarted) this.failTask(record, safeTaskError(turn?.error || turn?.status || "result_return_failed"));
    } else if (!succeeded) {
      this.failTask(record, safeTaskError(turn?.error || turn?.status || "turn_failed"));
    } else if (context.agentId === record.coordinatorAgentId && context.kind === "initial") {
      const hasAssignmentBlock = finalText.includes(TASK_ASSIGNMENT_START);
      const assignments = parseTaskAssignments(finalText);
      if (assignments.length) await Promise.all(assignments.map((assignment) => this.spawnAssignment(record, assignment, turnId, context.threadId)));
      else if (hasAssignmentBlock) {
        this.emitRoomEvent("taskAssignmentRejected", { taskId: record.id, reason: "invalid_or_excess_assignment_blocks", public: true });
        this.recordAssignmentFailure(record, null, "invalid_or_excess_assignment_blocks", turnId);
      }
    } else if (context.kind === "finalSummary" && !succeeded) {
      this.failTask(record, safeTaskError(turn?.error || turn?.status || "final_summary_failed"));
    }
    if (context.kind === "finalSummary") {
      record.finalSummaryCompleted = true;
      if (succeeded && record.failedAssignments.size) this.failTask(record, "delegated_target_failed");
    }
    this.maybeFinishTask(record);
  }

  handleNotification(event) {
    const params = event.params || {};
    const agentId = this.agentByThreadId.get(params.threadId) || null;
    const turnId = params.turnId || params.turn?.id || null;
    const turnContext = turnId ? this.turnContextById.get(turnId) : null;
    const roomId = turnContext?.roomId ?? this.roomByThreadId.get(params.threadId) ?? this.roomId;
    const taskId = turnContext?.taskId ?? this.taskId;
    if (event.method === "item/completed" && params.item?.type === "agentMessage") {
      const messageText = params.item.text || "";
      const messages = this.turnMessagesById.get(turnId) || [];
      messages.push(messageText);
      this.turnMessagesById.set(turnId, messages.slice(-20));
      const publicText = turnContext?.kind === "initial" && turnContext?.agentId === this.coordinatorAgent()?.id
        ? stripTaskAssignmentBlocks(messageText)
        : messageText;
      if (!publicText && turnContext?.public !== false) return;
      this.emitRoomEvent("agentMessage", {
        agentId,
        threadId: params.threadId,
        turnId,
        text: publicText,
        roomId,
        taskId,
        public: turnContext?.public !== false,
        internal: turnContext?.internal === true,
        assignmentId: turnContext?.assignment?.assignmentId || null,
      });
    } else if (event.method === "turn/completed") {
      this.expireApprovalsFor({ agentId, threadId: params.threadId, turnId }, "turn_completed");
      if (this.writeLock?.agentId === agentId && (!this.writeLock.threadId || this.writeLock.threadId === params.threadId)) this.writeLock = null;
      this.emitRoomEvent("turnCompleted", {
        agentId,
        threadId: params.threadId,
        turnId,
        turn: params.turn,
        roomId,
        taskId,
        public: turnContext?.public !== false,
        internal: turnContext?.internal === true,
        assignmentId: turnContext?.assignment?.assignmentId || null,
      });
      const finalText = this.turnMessagesById.get(turnId)?.at(-1) || "";
      void this.processCompletedTurn(turnId, params.turn || {}, turnContext, finalText);
    } else if (event.method === "item/completed" && ["commandExecution", "fileChange"].includes(params.item?.type)) {
      if (this.writeLock?.agentId === agentId) this.writeLock = null;
      this.emitRoomEvent("writeItemCompleted", { agentId, threadId: params.threadId, item: params.item, roomId, taskId, public: true });
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
      createdAt: new Date().toISOString(),
      roomId: turnContext?.roomId ?? this.roomByThreadId.get(params.threadId) ?? this.roomId,
      taskId: turnContext?.taskId ?? this.taskId,
    };
    const agent = this.agentById.get(agentId);
    const classification = classifyApprovalRequest({ method: approval.method, agentPermission: agent?.permission });
    if (agent?.permission === "coordinate" && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(approval.method)) {
      try {
        this.connection?.protocol?.resolveApproval(request.id, "cancel");
      } catch {
        // The runtime may already have closed the request; this event remains authoritative.
      }
      this.emitRoomEvent("coordinatorActionBlocked", {
        requestId: request.id,
        agentId,
        threadId: params.threadId,
        turnId,
        taskId: approval.taskId,
        roomId: approval.roomId,
        operationType: classification.operationType,
        reason: "coordinator_must_delegate",
        public: true,
      });
      return { blocked: true, approval, classification };
    }
    Object.assign(approval, {
      approvalKey: approvalIdentity(approval, approval.roomId).key,
      operationType: classification.operationType,
      requiresWriteLock: classification.requiresWriteLock,
      canAccept: classification.canAccept,
    });
    const duplicate = Array.from(this.pendingApprovals.values()).find((item) => item.approvalKey === approval.approvalKey);
    if (duplicate) return duplicate;
    const key = String(request.id);
    this.pendingApprovals.set(key, approval);
    const timer = setTimeout(() => this.expireApproval(key, "approval_timeout"), this.approvalTimeoutMs);
    timer.unref?.();
    this.approvalTimers.set(key, timer);
    this.emitRoomEvent("approvalRequested", approval);
    const taskRecord = approval.taskId ? this.taskRecords.get(approval.taskId) : null;
    if (taskRecord && !["succeeded", "failed"].includes(taskRecord.state)) this.taskStatusEvent(taskRecord, "taskWaitingApproval");
    return approval;
  }

  resolveApproval({ requestId, decision }) {
    if (!this.connection) throw new Error("Real runtime is not connected");
    const key = String(requestId);
    const approval = this.pendingApprovals.get(key);
    if (!approval) throw new Error("Approval request not found");
    const agent = this.agentById.get(approval.agentId);
    const classification = classifyApprovalRequest({ method: approval.method, agentPermission: agent?.permission });
    try {
      if (decision === "accept") {
        if (!classification.canAccept) throw new Error("This approval is not allowed for the member sandbox");
        if (this.writeLock && this.writeLock.agentId !== approval.agentId) {
          throw new Error(`Write lock is held by ${this.writeLock.agentId}`);
        }
      }
      this.connection.protocol.resolveApproval(approval.requestId, decision);
    } catch (error) {
      this.pendingApprovals.delete(key);
      this.clearApprovalTimer(key);
      try {
        this.connection.protocol.resolveApproval(approval.requestId, "cancel");
      } catch {
        // The protocol may have already closed the request.
      }
      this.emitRoomEvent("approvalFailed", { ...approval, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.pendingApprovals.delete(key);
    this.clearApprovalTimer(key);
    if (decision === "accept" && classification.requiresWriteLock) {
      this.writeLock = { agentId: approval.agentId, requestId: approval.requestId, approvalKey: approval.approvalKey, threadId: approval.threadId, acquiredAt: new Date().toISOString() };
    }
    if (decision !== "accept" && this.writeLock?.approvalKey === approval.approvalKey) this.writeLock = null;
    this.emitRoomEvent("approvalResolved", { ...approval, decision, requiresWriteLock: classification.requiresWriteLock });
    const taskRecord = approval.taskId ? this.taskRecords.get(approval.taskId) : null;
    if (taskRecord && !["succeeded", "failed"].includes(taskRecord.state)) this.taskStatusEvent(taskRecord, "taskStarted");
    return { approval, writeLock: this.writeLock };
  }

  clearApprovalTimer(requestId) {
    const timer = this.approvalTimers.get(String(requestId));
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(String(requestId));
  }

  expireApproval(requestId, error = "approval_timeout") {
    const key = String(requestId);
    const approval = this.pendingApprovals.get(key);
    if (!approval) return false;
    this.pendingApprovals.delete(key);
    this.clearApprovalTimer(key);
    try {
      if (this.connection) this.connection.protocol.resolveApproval(approval.requestId, "cancel");
    } catch {
      // The App Server may already have closed the request; the failure event
      // remains the authoritative UI state.
    }
    this.emitRoomEvent("approvalFailed", { ...approval, error });
    return true;
  }

  expireApprovalsFor({ agentId = null, threadId = null, turnId = null } = {}, error = "turn_completed") {
    for (const [requestId, approval] of this.pendingApprovals) {
      if (agentId && approval.agentId !== agentId) continue;
      if (threadId && approval.threadId !== threadId) continue;
      if (turnId && approval.turnId && approval.turnId !== turnId) continue;
      this.expireApproval(requestId, error);
    }
  }

  expireStaleApprovals(now = Date.now()) {
    for (const [requestId, approval] of this.pendingApprovals) {
      const created = Date.parse(approval.createdAt || "");
      if (Number.isFinite(created) && now - created >= this.approvalTimeoutMs) this.expireApproval(requestId, "approval_timeout");
    }
  }

  listEvents(after = 0) {
    return this.events.filter((event) => event.sequence > after);
  }
}

export const teamRoomRuntime = new TeamRoomRuntimeManager();
