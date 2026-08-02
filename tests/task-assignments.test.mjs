import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskAssignment,
  formatTaskResult,
  parseTaskAssignment,
  parseTaskAssignments,
  parseTaskResult,
  stripTaskAssignmentBlocks,
  validateTaskAssignment,
} from "../src/lib/taskAssignments.js";

const base = (overrides = {}) => ({
  assignmentId: "assignment-1",
  parentTaskId: "task-root",
  targetAgentId: "developer",
  objective: "核对实现风险",
  acceptanceCriteria: ["给出结论"],
  visibility: "coordinator-only",
  depth: 1,
  ...overrides,
});

test("ordinary mentions and promises do not parse as a real assignment", () => {
  assert.deepEqual(parseTaskAssignments("@开发 我会分配任务"), []);
  assert.equal(parseTaskAssignment("总控说稍后委派"), null);
});

test("strict parser accepts up to four assignments and strips protocol blocks from public text", () => {
  const blocks = [1, 2, 3, 4].map((index) => formatTaskAssignment(base({
    assignmentId: `assignment-${index}`,
    targetAgentId: `agent-${index}`,
  })));
  const parsed = parseTaskAssignments(`计划如下：\n${blocks.join("\n")}\n请等待结果。`);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[2].targetAgentId, "agent-3");
  assert.match(stripTaskAssignmentBlocks(`计划如下：\n${blocks[0]}\n请等待结果。`), /^计划如下：\n\n?请等待结果。$/);
  const five = [...blocks, formatTaskAssignment(base({ assignmentId: "assignment-5", targetAgentId: "agent-5" }))].join("\n");
  assert.deepEqual(parseTaskAssignments(five), []);
});

test("assignment validation binds source turn, target member, depth, cycle, and idempotency", () => {
  const parentTask = {
    id: "task-root",
    roomId: "room-1",
    depth: 0,
    coordinatorTurnId: "turn-coordinator",
    coordinatorThreadId: "thread-coordinator",
    coordinatorAgentId: "coordinator",
    agentPath: ["coordinator"],
    delegationCount: 0,
  };
  const args = {
    assignment: base(),
    coordinatorAgentId: "coordinator",
    sourceRoomId: "room-1",
    sourceTurnId: "turn-coordinator",
    sourceThreadId: "thread-coordinator",
    parentTask,
    agents: [{ id: "coordinator" }, { id: "developer" }],
  };
  assert.equal(validateTaskAssignment(args).ok, true);
  assert.equal(validateTaskAssignment({ ...args, sourceTurnId: "turn-other" }).reason, "assignment_source_not_coordinator_turn");
  assert.equal(validateTaskAssignment({ ...args, assignmentsById: new Map([["assignment-1", args.assignment]]) }).reason, "assignment_duplicate");
  assert.equal(validateTaskAssignment({ ...args, assignment: base({ depth: 3 }) }).reason, "assignment_depth_invalid");
  assert.equal(validateTaskAssignment({ ...args, assignment: base({ targetAgentId: "coordinator" }) }).reason, "assignment_self_target");
  assert.equal(validateTaskAssignment({ ...args, assignment: base({ targetAgentId: "developer" }), parentTask: { ...parentTask, agentPath: ["coordinator", "developer"] } }).reason, "assignment_cycle");
});

test("task results retain a strict internal status and sanitize local paths", () => {
  const result = parseTaskResult(formatTaskResult({ assignmentId: "a", parentTaskId: "t", targetAgentId: "developer", sourceTurnId: "turn-1", status: "failed", summary: "G:\\private\\secret.txt" }));
  assert.equal(result.status, "failed");
  assert.match(result.summary, /本机路径已隐藏/);
});
