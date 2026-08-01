import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TeamRoomRuntimeManager } from "../server/teamRoomRuntimeManager.mjs";

class FakeProtocol extends EventEmitter {
  constructor() {
    super();
    this.startedThreads = [];
    this.startedTurns = [];
    this.approvalResponses = [];
  }
  async initialize() {}
  async startAgentThread(agent) {
    this.startedThreads.push(agent);
    return { id: `thread-${agent.id}` };
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
