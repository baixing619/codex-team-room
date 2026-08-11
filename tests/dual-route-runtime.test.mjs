import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TeamRoomRuntimeManager } from "../server/teamRoomRuntimeManager.mjs";
import { formatTaskAssignment } from "../src/lib/taskAssignments.js";

class FakeProtocol extends EventEmitter {
  constructor() {
    super();
    this.startedTurns = [];
    this.turnCounts = new Map();
  }
  async initialize() {}
  async startAgentThread(agent) { return { id: `thread-${agent.id}` }; }
  async resumeAgentThread(threadId) { return { id: threadId }; }
  async startAgentTurn(input) {
    this.startedTurns.push(input);
    const count = (this.turnCounts.get(input.agent.id) || 0) + 1;
    this.turnCounts.set(input.agent.id, count);
    return { id: `turn-${input.agent.id}-${count}` };
  }
  resolveApproval() {}
  async interruptAgentTurn(_threadId, turnId) { return { turn: { id: turnId, status: "interrupted" } }; }
}

function setup() {
  const protocol = new FakeProtocol();
  const manager = new TeamRoomRuntimeManager({
    statusProvider: () => ({ available: true, executable: "C:\\fake\\codex.exe", version: "codex 1" }),
    runtimeFactory: () => ({ protocol, child: { killed: false, kill() { this.killed = true; } } }),
  });
  const agents = [
    { id: "coordinator", name: "总控", role: "总控", model: "gpt-5.6-sol", reasoning: "high", permission: "coordinate", participation: "always" },
    { id: "developer", name: "开发", role: "开发", model: "gpt-5.6-terra", reasoning: "xhigh", permission: "request-write", participation: "relevant" },
    { id: "reviewer", name: "审核", role: "审核", model: "gpt-5.6-terra", reasoning: "high", permission: "read-only", participation: "review" },
  ];
  return { manager, protocol, agents };
}

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

async function complete(protocol, started, text = "已完成", status = "completed") {
  protocol.emit("notification", { method: "item/completed", params: { threadId: started.threadId, turnId: started.turnId, item: { type: "agentMessage", text } } });
  protocol.emit("notification", { method: "turn/completed", params: { threadId: started.threadId, turnId: started.turnId, turn: { status } } });
  await flush();
}

function started(manager, predicate) {
  return manager.listEvents().filter((event) => event.type === "turnStarted").find(predicate);
}

test("runtime ignores stale keyword activation and starts only coordinator for an ordinary task", async () => {
  const { manager, protocol, agents } = setup();
  await manager.connect({ cwd: "G:\\project", roomId: "room-route", agents, confirmed: true });
  const result = await manager.dispatch({
    text: "修复这个问题并做必要测试",
    decisions: [{ agentId: "coordinator", decision: "speak" }, { agentId: "developer", decision: "speak" }],
    messageId: "message-route",
    taskId: "task-route",
    roomId: "room-route",
  });
  assert.deepEqual(result.turns.map((turn) => turn.agentId), ["coordinator"]);
  assert.equal(started(manager, (event) => event.agentId === "developer"), undefined);
  await complete(protocol, started(manager, (event) => event.agentId === "coordinator"), "这是简单任务，可直接给出说明。" );
  assert.equal((await manager.waitForTask("task-route")).status, "succeeded");
});

test("an explicit specialist mention uses the fast route without coordinator", async () => {
  const { manager, protocol, agents } = setup();
  await manager.connect({ cwd: "G:\\project", roomId: "room-fast", agents, confirmed: true });
  const result = await manager.dispatch({
    text: "@开发 请直接检查这个函数",
    decisions: [{ agentId: "coordinator", decision: "speak" }],
    messageId: "message-fast",
    taskId: "task-fast",
    roomId: "room-fast",
  });
  assert.deepEqual(result.turns.map((turn) => turn.agentId), ["developer"]);
  await complete(protocol, started(manager, (event) => event.agentId === "developer"), "检查完成");
  assert.equal((await manager.waitForTask("task-fast")).status, "succeeded");
});

test("collaboration route discusses sequentially, coordinator judges, then one execution runs", async () => {
  const { manager, protocol, agents } = setup();
  await manager.connect({ cwd: "G:\\project", roomId: "room-collab", agents, confirmed: true });
  const result = await manager.dispatch({
    text: "请讨论并比较两个方案，确定更优解后再执行",
    decisions: [{ agentId: "developer", decision: "speak" }],
    messageId: "message-collab",
    taskId: "task-collab",
    roomId: "room-collab",
  });
  assert.deepEqual(result.turns.map((turn) => turn.agentId), ["coordinator"]);

  const analysisOne = formatTaskAssignment({ assignmentId: "analysis-developer", parentTaskId: "task-collab", targetAgentId: "developer", objective: "提出实现方案", acceptanceCriteria: ["说明优缺点"], visibility: "room", depth: 1, phase: "analysis" });
  const analysisTwo = formatTaskAssignment({ assignmentId: "analysis-reviewer", parentTaskId: "task-collab", targetAgentId: "reviewer", objective: "评审并改进方案", acceptanceCriteria: ["回应前序结论"], visibility: "room", depth: 1, phase: "analysis" });
  await complete(protocol, started(manager, (event) => event.agentId === "coordinator" && event.turnKind === "initial"), `先分析并进入协作线。\n${analysisOne}\n${analysisTwo}`);

  const firstTarget = started(manager, (event) => event.turnKind === "delegatedTarget" && event.assignmentId === "analysis-developer");
  assert.ok(firstTarget);
  assert.equal(started(manager, (event) => event.assignmentId === "analysis-reviewer"), undefined);
  assert.equal(firstTarget.assignmentPhase, "analysis");
  const completeFirstOutput = `方案A：改运行时边界。${"完整细节".repeat(600)}结论尾标记`;
  await complete(protocol, firstTarget, completeFirstOutput);

  const firstReturn = started(manager, (event) => event.turnKind === "resultReturn" && event.assignmentId === "analysis-developer");
  await complete(protocol, firstReturn, "已接收方案A");
  const secondTarget = started(manager, (event) => event.turnKind === "delegatedTarget" && event.assignmentId === "analysis-reviewer");
  assert.ok(secondTarget);
  const secondInput = protocol.startedTurns.find((turn) => turn.clientUserMessageId === "assignment-analysis-reviewer");
  assert.match(secondInput.text, /方案A/);
  assert.match(secondInput.text, /结论尾标记/);
  assert.match(secondInput.text, /异议：/);
  assert.match(secondInput.text, /不得为了异议而异议/);
  assert.equal(secondTarget.assignmentPhase, "analysis");
  await complete(protocol, secondTarget, "异议：方案A没有说明迟到完成事件的幂等处理。建议用 turnId 拒绝旧事件。" );

  const secondReturn = started(manager, (event) => event.turnKind === "resultReturn" && event.assignmentId === "analysis-reviewer");
  await complete(protocol, secondReturn, "已接收审核结论");
  const firstSummary = started(manager, (event) => event.turnKind === "finalSummary");
  assert.ok(firstSummary);
  const firstSummaryInput = protocol.startedTurns.find((turn) => turn.clientUserMessageId === "summary-task-collab-1");
  assert.match(firstSummaryInput.text, /异议：方案A没有说明/);
  assert.match(firstSummaryInput.text, /逐条判断所有以“异议：”开头/);

  const execution = formatTaskAssignment({ assignmentId: "execute-developer", parentTaskId: "task-collab", targetAgentId: "developer", objective: "按裁决实现方案", acceptanceCriteria: ["完成必要验证"], visibility: "room", depth: 1, phase: "execution" });
  await complete(protocol, firstSummary, `采用方案A。\n${execution}`);
  assert.equal(manager.listEvents().filter((event) => event.type === "coordinatorDecisionLocked").length, 1);
  const executionTarget = started(manager, (event) => event.turnKind === "delegatedTarget" && event.assignmentId === "execute-developer");
  assert.ok(executionTarget);
  assert.equal(executionTarget.assignmentPhase, "execution");
  const executionInput = protocol.startedTurns.find((turn) => turn.clientUserMessageId === "assignment-execute-developer");
  assert.equal(executionInput.agent.permission, "request-write");
  assert.match(executionInput.text, /异议窗口已经关闭/);
  await complete(protocol, executionTarget, "实现和必要验证已完成");

  const executionReturn = started(manager, (event) => event.turnKind === "resultReturn" && event.assignmentId === "execute-developer");
  await complete(protocol, executionReturn, "已接收执行结果");
  const summaries = manager.listEvents().filter((event) => event.type === "turnStarted" && event.turnKind === "finalSummary");
  assert.equal(summaries.length, 2);
  await complete(protocol, summaries[1], "验收通过，任务完成。" );
  assert.equal((await manager.waitForTask("task-collab")).status, "succeeded");
});
