import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TeamRoomRuntimeManager } from "../server/teamRoomRuntimeManager.mjs";

class FakeProtocol extends EventEmitter {
  constructor() {
    super();
    this.startedThreads = [];
    this.resumedThreads = [];
    this.startedTurns = [];
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
    return { id: `turn-${input.agent.id}` };
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
  await manager.dispatch({ text: "继续", decisions, messageId: "message-2" });
  assert.equal(protocol.startedThreads.length, 2);
  assert.equal(protocol.startedTurns.length, 4);
  assert.equal(manager.status().agentThreads.developer, "thread-developer");
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
