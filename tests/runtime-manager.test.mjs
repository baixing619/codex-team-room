import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TeamRoomRuntimeManager } from "../server/teamRoomRuntimeManager.mjs";
import { formatTaskAssignment } from "../src/lib/taskAssignments.js";

class FakeProtocol extends EventEmitter {
  constructor() {
    super();
    this.startedThreads = [];
    this.resumedThreads = [];
    this.startedTurns = [];
    this.turnCounts = new Map();
    this.approvalResponses = [];
  }
  async initialize() {}
  async startAgentThread(agent, cwd) {
    this.startedThreads.push({ agent, cwd });
    return { id: `thread-${agent.id}` };
  }
  async resumeAgentThread(threadId, agent, cwd) {
    this.resumedThreads.push({ threadId, agent, cwd });
    return { id: threadId };
  }
  async startAgentTurn(input) {
    this.startedTurns.push(input);
    const count = (this.turnCounts.get(input.agent.id) || 0) + 1;
    this.turnCounts.set(input.agent.id, count);
    return { id: `turn-${input.agent.id}${count > 1 ? `-${count}` : ""}` };
  }
  resolveApproval(requestId, decision) {
    this.approvalResponses.push({ requestId, decision });
  }
}

function createManager() {
  const protocol = new FakeProtocol();
  const manager = new TeamRoomRuntimeManager({
    statusProvider: () => ({ available: true, executable: "C:\\fake\\codex.exe", version: "codex 1" }),
    runtimeFactory: () => ({ protocol, child: { killed: false, kill() { this.killed = true; } } }),
  });
  const agents = [
    { id: "coordinator", model: "gpt-5.6-sol", reasoning: "high", permission: "coordinate" },
    { id: "developer", model: "gpt-5.6-terra", reasoning: "xhigh", permission: "request-write" },
    { id: "reviewer", model: "gpt-5.6-terra", reasoning: "high", permission: "read-only" },
  ];
  return { manager, protocol, agents };
}

const flushRuntime = () => new Promise((resolve) => setImmediate(resolve));

async function completeTurn(protocol, event, { text = "已完成", status = "completed" } = {}) {
  protocol.emit("notification", {
    method: "item/completed",
    params: { threadId: event.threadId, turnId: event.turnId, item: { type: "agentMessage", text } },
  });
  protocol.emit("notification", {
    method: "turn/completed",
    params: { threadId: event.threadId, turnId: event.turnId, turn: { status } },
  });
  await flushRuntime();
  await flushRuntime();
}

test("explicit confirmation is required before spawning a real runtime", async () => {
  const { manager, agents } = createManager();
  await assert.rejects(() => manager.connect({ cwd: "G:\\project", agents, confirmed: false }), /explicit confirmation/);
});

test("dispatch creates one persistent thread per speaking member", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", agents, confirmed: true });
  const decisions = [
    { agentId: "coordinator", decision: "speak" },
    { agentId: "developer", decision: "speak" },
    { agentId: "reviewer", decision: "silent" },
  ];
  await manager.dispatch({ text: "实现并检查", decisions, messageId: "message-1" });
  for (const input of protocol.startedTurns) {
    protocol.emit("notification", { method: "turn/completed", params: { threadId: `thread-${input.agent.id}`, turnId: `turn-${input.agent.id}`, turn: { status: "completed" } } });
  }
  await manager.dispatch({ text: "继续", decisions, messageId: "message-2" });
  assert.equal(protocol.startedThreads.length, 2);
  assert.equal(protocol.startedTurns.length, 4);
  assert.equal(manager.status().agentThreads.developer, "thread-developer");
});

test("runtime dispatch upgrades explicitly mentioned silent members and preserves their bound threads", async () => {
  const { manager, protocol, agents } = createManager();
  agents[0] = { ...agents[0], name: "总控", participation: "always" };
  agents[1] = { ...agents[1], name: "开发", participation: "relevant", boundThreadId: "thread-developer-bound", threadBinding: "existing" };
  agents[2] = { ...agents[2], name: "审核", participation: "review", boundThreadId: "thread-reviewer-bound", threadBinding: "existing" };
  agents.push({ id: "researcher", name: "资料", model: "gpt-5.6-terra", reasoning: "medium", permission: "read-only", participation: "knowledge" });
  await manager.connect({ cwd: "G:\\project", roomId: "room-mentions", agents, confirmed: true });

  const result = await manager.dispatch({
    text: "@开发 @审核 请分别回复",
    decisions: [
      { agentId: "coordinator", decision: "speak" },
      { agentId: "developer", decision: "silent" },
      { agentId: "reviewer", decision: "silent" },
      { agentId: "researcher", decision: "silent" },
    ],
    messageId: "message-mentions",
    roomId: "room-mentions",
  });

  assert.deepEqual(result.turns.map((turn) => turn.threadId).sort(), ["thread-coordinator", "thread-developer-bound", "thread-reviewer-bound"]);
  assert.equal(protocol.startedThreads.length, 1);
  assert.deepEqual(protocol.resumedThreads.map((item) => item.threadId).sort(), ["thread-developer-bound", "thread-reviewer-bound"]);
  assert.equal(manager.listEvents().filter((event) => event.type === "turnStarted" && ["developer", "reviewer"].includes(event.agentId)).every((event) => event.public === true), true);
  assert.ok(!result.turns.some((turn) => turn.agentId === "researcher"));
});

test("runtime-side explicit promotion never gives a deferred member an empty context", async () => {
  const { manager, protocol, agents } = createManager();
  agents[1] = { ...agents[1], name: "开发", participation: "relevant" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-recovery", agents, confirmed: true });

  await manager.dispatch({
    text: "@开发 请回复",
    decisions: [{ agentId: "developer", decision: "silent" }],
    messageId: "message-recovery",
    roomId: "room-recovery",
    sharedContext: {
      id: "context-recovery",
      roomId: "room-recovery",
      roomName: "恢复项目",
      snapshot: { knowledge: [{ id: "k1", title: "完整知识", body: "完整正文" }], recentMessages: [{ id: "m1", role: "user", text: "完整消息" }] },
      deliveriesByAgentId: { developer: { mode: "deferred", cursorKey: "agent:developer" } },
    },
  });

  assert.equal(protocol.startedTurns.length, 1);
  assert.equal(protocol.startedTurns[0].agent.id, "developer");
  assert.equal(protocol.startedTurns[0].sharedContext.mode, "full");
  assert.equal(protocol.startedTurns[0].sharedContext.knowledge[0].body, "完整正文");
});

test("runtime refuses a deferred promotion when no recovery snapshot is available", async () => {
  const { manager, protocol, agents } = createManager();
  agents[1] = { ...agents[1], name: "开发", participation: "relevant" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-recovery-missing", agents, confirmed: true });

  await assert.rejects(
    () => manager.dispatch({
      text: "@开发 请回复",
      decisions: [{ agentId: "developer", decision: "silent" }],
      messageId: "message-recovery-missing",
      roomId: "room-recovery-missing",
      sharedContext: { id: "context-recovery-missing", deliveriesByAgentId: { developer: { mode: "deferred" } } },
    }),
    /shared_context_recovery_snapshot_required/,
  );
  assert.equal(protocol.startedTurns.length, 0);
});

test("coordinator can dispatch four independent assignments and only publish the final summary", async () => {
  const { manager, protocol, agents } = createManager();
  agents[0] = { ...agents[0], name: "总控", systemPrompt: "旧总控提示词" };
  agents[1] = { ...agents[1], name: "开发", boundThreadId: "thread-developer-bound", threadBinding: "existing" };
  agents[2] = { ...agents[2], name: "审核", boundThreadId: "thread-reviewer-bound", threadBinding: "existing" };
  agents.push(
    { id: "researcher", name: "资料", model: "gpt-5.6-terra", reasoning: "medium", permission: "read-only", boundThreadId: "thread-researcher-bound", threadBinding: "existing" },
    { id: "pro", name: "PRO项目专员", model: "gpt-5.6-terra", reasoning: "medium", permission: "read-only", boundThreadId: "thread-pro-bound", threadBinding: "existing" },
  );
  await manager.connect({ cwd: "G:\\project", roomId: "room-delegation", agents, confirmed: true });
  const dispatch = await manager.dispatch({
    text: "请协调，其他人不要发言，只让总控回复",
    decisions: [{ agentId: "coordinator", decision: "speak" }],
    messageId: "message-delegation",
    taskId: "task-delegation",
    roomId: "room-delegation",
  });
  assert.match(protocol.startedTurns.find((turn) => turn.agent.id === "coordinator").text, /parentTaskId=task-delegation/);
  assert.match(protocol.startedTurns.find((turn) => turn.agent.id === "coordinator").text, /depth=1/);
  assert.match(protocol.startedTurns.find((turn) => turn.agent.id === "coordinator").text, /developer\/开发/);
  assert.match(protocol.startedTurns.find((turn) => turn.agent.id === "coordinator").text, /pro\/PRO项目专员/);
  const initial = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "initial");
  const assignments = ["developer", "reviewer", "researcher", "pro"].map((targetAgentId, index) => formatTaskAssignment({
    assignmentId: `assignment-${index + 1}`,
    parentTaskId: "task-delegation",
    targetAgentId,
    objective: `核对第${index + 1}项`,
    acceptanceCriteria: ["给出结论"],
    visibility: "coordinator-only",
    depth: 1,
  }));
  await completeTurn(protocol, initial, { text: `先说明计划\n${assignments.join("\n")}` });
  await flushRuntime();
  const targetStarts = manager.listEvents().filter((event) => event.type === "turnStarted" && event.turnKind === "delegatedTarget");
  assert.deepEqual(targetStarts.map((event) => event.threadId).sort(), ["thread-developer-bound", "thread-pro-bound", "thread-researcher-bound", "thread-reviewer-bound"]);
  assert.deepEqual(dispatch.turns.map((turn) => turn.threadId), ["thread-coordinator"]);
  for (const target of targetStarts) await completeTurn(protocol, target, { text: `${target.agentId} 已完成` });
  await flushRuntime();
  const completedResultIds = new Set();
  while (completedResultIds.size < 4) {
    await flushRuntime();
    const resultStarts = manager.listEvents().filter((event) => event.type === "turnStarted" && event.turnKind === "resultReturn" && !completedResultIds.has(event.turnId));
    assert.ok(resultStarts.length, "expected the next result return turn");
    for (const result of resultStarts) {
      completedResultIds.add(result.turnId);
      await completeTurn(protocol, result, { text: "内部结果已回流" });
    }
  }
  await flushRuntime();
  const summary = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "finalSummary");
  assert.ok(summary);
  assert.equal(summary.public, true);
  await completeTurn(protocol, summary, { text: "最终总控汇总" });
  const publicMessages = manager.listEvents().filter((event) => event.type === "agentMessage" && event.public !== false);
  assert.equal(publicMessages.length, 2);
  assert.equal(publicMessages.at(-1).text, "最终总控汇总");
  assert.equal(manager.listEvents().filter((event) => event.type === "agentMessage" && event.public === false).length >= 4, true);
  assert.equal((await manager.waitForTask("task-delegation")).status, "succeeded");
});

test("a failed delegated target is included in the final summary and terminates the task", async () => {
  const { manager, protocol, agents } = createManager();
  agents[0] = { ...agents[0], name: "总控" };
  agents[1] = { ...agents[1], name: "开发", boundThreadId: "thread-developer-bound", threadBinding: "existing" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-delegation-fail", agents, confirmed: true });
  await manager.dispatch({ text: "其他人不要发言，只让总控回复", decisions: [{ agentId: "coordinator", decision: "speak" }], messageId: "message-delegation-fail", taskId: "task-delegation-fail", roomId: "room-delegation-fail" });
  const initial = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "initial");
  const assignment = formatTaskAssignment({ assignmentId: "assignment-fail", parentTaskId: "task-delegation-fail", targetAgentId: "developer", objective: "检查失败路径", acceptanceCriteria: ["回报失败"], visibility: "coordinator-only", depth: 1 });
  await completeTurn(protocol, initial, { text: assignment });
  await flushRuntime();
  const target = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "delegatedTarget");
  await completeTurn(protocol, target, { text: "无法完成", status: "failed" });
  await flushRuntime();
  const result = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "resultReturn");
  assert.ok(result);
  await completeTurn(protocol, result, { text: "失败结果已回流" });
  await flushRuntime();
  const summary = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "finalSummary");
  assert.ok(summary);
  await completeTurn(protocol, summary, { text: "汇总：开发成员失败，任务终止" });
  assert.equal((await manager.waitForTask("task-delegation-fail")).status, "failed");
  assert.equal(manager.listEvents().some((event) => event.type === "taskFailed"), true);
  assert.equal(manager.listEvents().some((event) => event.type === "agentMessage" && event.public === true && event.text.includes("开发成员失败")), true);
});

test("normal room assignments publish the delegated member message", async () => {
  const { manager, protocol, agents } = createManager();
  agents[0] = { ...agents[0], name: "总控" };
  agents[1] = { ...agents[1], name: "开发", boundThreadId: "thread-developer-bound", threadBinding: "existing" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-public", agents, confirmed: true });
  await manager.dispatch({ text: "请协调开发和审核", decisions: [{ agentId: "coordinator", decision: "speak" }], messageId: "message-public", taskId: "task-public", roomId: "room-public" });
  const initial = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "initial");
  await completeTurn(protocol, initial, { text: formatTaskAssignment({ assignmentId: "assignment-public", parentTaskId: "task-public", targetAgentId: "developer", objective: "核对实现", acceptanceCriteria: ["报告结果"], visibility: "room", depth: 1 }) });
  await flushRuntime();
  const target = manager.listEvents().find((event) => event.type === "turnStarted" && event.turnKind === "delegatedTarget");
  assert.equal(target.public, true);
  protocol.emit("notification", { method: "item/completed", params: { threadId: target.threadId, turnId: target.turnId, item: { type: "agentMessage", text: "开发公开结果" } } });
  assert.equal(manager.listEvents().at(-1).type, "agentMessage");
  assert.equal(manager.listEvents().at(-1).public, true);
  manager.disconnect();
});

test("independent member conversations receive the same context id and execution-off is enforced server-side", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", roomId: "room-proof", agents, confirmed: true });
  const sharedContext = {
    id: "context-shared-proof",
    roomId: "room-proof",
    roomName: "真实项目",
    recentMessages: [{ role: "agent", agentName: "审核", sourceThreadId: "thread-reviewer", text: "发现一个风险" }],
  };
  const result = await manager.dispatch({
    text: "请共同确认",
    decisions: [{ agentId: "coordinator", decision: "speak" }, { agentId: "developer", decision: "speak" }],
    messageId: "message-proof",
    roomId: "room-proof",
    sharedContext,
    executionMode: false,
  });

  assert.deepEqual(result.turns.map((turn) => turn.threadId).sort(), ["thread-coordinator", "thread-developer"]);
  assert.equal(new Set(protocol.startedTurns.map((turn) => turn.sharedContext.id)).size, 1);
  assert.ok(protocol.startedTurns.every((turn) => turn.sharedContext.id === "context-shared-proof"));
  assert.equal(protocol.startedTurns.find((turn) => turn.agent.id === "developer").agent.permission, "read-only");
  assert.equal(protocol.startedTurns.find((turn) => turn.agent.id === "coordinator").agent.permission, "coordinate");
});

test("an explicit current-project binding is resumed, while an automatic member gets its own thread", async () => {
  const { manager, protocol, agents } = createManager();
  agents[1] = { ...agents[1], boundThreadId: "thread-existing-project", threadBinding: "existing" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-project", taskId: "task-1", agents, confirmed: true });

  assert.equal(await manager.ensureAgentThread("developer"), "thread-existing-project");
  assert.equal(protocol.startedThreads.length, 0);
  assert.deepEqual(protocol.resumedThreads[0], {
    threadId: "thread-existing-project",
    agent: agents[1],
    cwd: "G:\\project",
  });
  const bindingEvent = manager.listEvents().find((event) => event.type === "agentThreadBound");
  assert.equal(bindingEvent.bindingMode, "existing");
  assert.equal(bindingEvent.roomId, "room-project");
  assert.equal(bindingEvent.taskId, "task-1");
});

test("a runtime thread id is also resumed after a safe reconnect", async () => {
  const { manager, protocol, agents } = createManager();
  agents[2] = { ...agents[2], runtimeThreadId: "thread-created-earlier" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-project", agents, confirmed: true });

  assert.equal(await manager.ensureAgentThread("reviewer"), "thread-created-earlier");
  assert.equal(protocol.startedThreads.length, 0);
  assert.equal(protocol.resumedThreads[0].threadId, "thread-created-earlier");
});

test("switching a room or project reconnects only after pending approvals and writes are clear", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project-one", roomId: "room-one", taskId: "task-one", agents, confirmed: true });
  await manager.ensureAgentThread("developer");
  protocol.emit("approval", { id: 90, method: "item/fileChange/requestApproval", params: { threadId: "thread-developer" } });

  await assert.rejects(
    () => manager.connect({ cwd: "G:\\project-two", roomId: "room-two", taskId: "task-two", agents, confirmed: true }),
    /approval is pending/,
  );
  manager.resolveApproval({ requestId: 90, decision: "decline" });

  await manager.connect({ cwd: "G:\\project-two", roomId: "room-two", taskId: "task-two", agents, confirmed: true });
  assert.equal(manager.status().cwd, "G:\\project-two");
  assert.deepEqual(manager.status().agentThreads, {});
  const disconnected = manager.listEvents().find((event) => event.type === "runtimeDisconnected");
  assert.equal(disconnected.roomId, "room-one");
  assert.equal(disconnected.taskId, "task-one");
});

test("a write lock also prevents switching to another project", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project-one", roomId: "room-one", agents, confirmed: true });
  await manager.ensureAgentThread("developer");
  protocol.emit("approval", { id: 91, method: "item/fileChange/requestApproval", params: { threadId: "thread-developer" } });
  manager.resolveApproval({ requestId: 91, decision: "accept" });

  await assert.rejects(
    () => manager.connect({ cwd: "G:\\project-two", roomId: "room-two", agents, confirmed: true }),
    /write lock is active/,
  );
});

test("async runtime messages keep the room and task that started their turn", async () => {
  const { manager, protocol, agents } = createManager();
  agents[1] = { ...agents[1], systemPrompt: "只负责当前项目的实现" };
  await manager.connect({ cwd: "G:\\project", roomId: "room-a", taskId: "task-a", agents, confirmed: true });
  await manager.dispatch({
    text: "实现并验证",
    decisions: [{ agentId: "developer", decision: "speak" }],
    messageId: "message-a",
    roomId: "room-a",
    taskId: "task-a",
  });
  protocol.emit("notification", {
    method: "item/completed",
    params: { threadId: "thread-developer", turnId: "turn-developer", item: { type: "agentMessage", text: "已完成" } },
  });

  const event = manager.listEvents().at(-1);
  assert.equal(event.type, "agentMessage");
  assert.equal(event.roomId, "room-a");
  assert.equal(event.taskId, "task-a");
  assert.equal(protocol.resumedThreads.length, 0);
  protocol.emit("notification", { method: "turn/completed", params: { threadId: "thread-developer", turnId: "turn-developer", turn: { status: "completed" } } });
  await manager.dispatch({
    text: "继续验证",
    decisions: [{ agentId: "developer", decision: "speak" }],
    messageId: "message-b",
    roomId: "room-a",
    taskId: "task-b",
  });
  assert.equal(protocol.resumedThreads.length, 1);
});

test("server-side write lock prevents a second member from approving concurrently", async () => {
  const { manager, protocol, agents } = createManager();
  agents.push({ id: "developer2", model: "gpt-5.6-sol", reasoning: "high", permission: "request-write" });
  await manager.connect({ cwd: "G:\\project", agents, confirmed: true });
  await manager.ensureAgentThread("developer");
  await manager.ensureAgentThread("developer2");
  protocol.emit("approval", { id: 10, method: "item/commandExecution/requestApproval", params: { threadId: "thread-developer" } });
  protocol.emit("approval", { id: 11, method: "item/commandExecution/requestApproval", params: { threadId: "thread-developer2" } });
  manager.resolveApproval({ requestId: 10, decision: "accept" });
  assert.throws(() => manager.resolveApproval({ requestId: 11, decision: "accept" }), /Write lock/);
});

test("completed write items release the server-side lock", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", agents, confirmed: true });
  await manager.ensureAgentThread("developer");
  protocol.emit("approval", { id: 15, method: "item/fileChange/requestApproval", params: { threadId: "thread-developer" } });
  manager.resolveApproval({ requestId: 15, decision: "accept" });
  protocol.emit("notification", { method: "item/completed", params: { threadId: "thread-developer", item: { type: "fileChange", status: "completed" } } });
  assert.equal(manager.status().writeLock, null);
});

test("coordinator command approvals are cancelled without a card or write lock", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", roomId: "room-approval", agents, confirmed: true });
  await manager.ensureAgentThread("coordinator");
  protocol.emit("approval", {
    id: 20,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-coordinator", command: "Get-Content README.md" },
  });

  const result = manager.listEvents().at(-1);
  assert.equal(result.type, "coordinatorActionBlocked");
  assert.deepEqual(protocol.approvalResponses.at(-1), { requestId: 20, decision: "cancel" });
  assert.equal(manager.status().pendingApprovals, 0);
  assert.equal(manager.status().writeLock, null);
});

test("read-only members can approve a read-only command without acquiring a write lock", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", roomId: "room-read-only", agents, confirmed: true });
  await manager.ensureAgentThread("reviewer");
  protocol.emit("approval", {
    id: 24,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-reviewer", command: "Get-Content README.md" },
  });
  const result = manager.resolveApproval({ requestId: 24, decision: "accept" });
  assert.equal(result.approval.canAccept, true);
  assert.equal(result.approval.requiresWriteLock, false);
  assert.equal(manager.status().writeLock, null);
  assert.deepEqual(protocol.approvalResponses.at(-1), { requestId: 24, decision: "accept" });
});

test("turn completion and disconnect emit failure and clear pending approvals", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", roomId: "room-approval", agents, confirmed: true });
  await manager.ensureAgentThread("reviewer");
  protocol.emit("approval", {
    id: 21,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-reviewer", turnId: "turn-approval", command: "Get-Content README.md" },
  });
  protocol.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-reviewer", turnId: "turn-approval", turn: { status: "cancelled" } },
  });
  assert.equal(manager.status().pendingApprovals, 0);
  assert.equal(manager.listEvents().some((event) => event.type === "approvalFailed" && event.error === "turn_completed"), true);

  protocol.emit("approval", {
    id: 22,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-reviewer", command: "Get-Content README.md" },
  });
  manager.disconnect();
  assert.equal(manager.listEvents().some((event) => event.type === "approvalFailed" && event.requestId === 22 && event.error === "runtime_disconnected"), true);
  assert.equal(manager.status().writeLock, null);
});

test("explicit expiry cancels the App Server request and emits approvalFailed", async () => {
  const { manager, protocol, agents } = createManager();
  await manager.connect({ cwd: "G:\\project", agents, confirmed: true });
  await manager.ensureAgentThread("developer");
  protocol.emit("approval", {
    id: 23,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-developer", command: "修改项目文件" },
  });
  assert.equal(manager.expireApproval(23, "approval_timeout"), true);
  assert.equal(manager.status().pendingApprovals, 0);
  assert.deepEqual(protocol.approvalResponses.at(-1), { requestId: 23, decision: "cancel" });
  assert.equal(manager.listEvents().at(-1).type, "approvalFailed");
  assert.equal(manager.listEvents().at(-1).error, "approval_timeout");
});
