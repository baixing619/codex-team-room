import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskAssignment,
  formatTaskResult,
  parseTaskAssignment,
  parseTaskAssignments,
  parseTaskResult,
  sanitizeTaskText,
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

test("assignment idempotency is scoped to the parent task lifecycle", () => {
  const parent = {
    id: "task-one",
    roomId: "room-1",
    depth: 0,
    coordinatorTurnId: "turn-one",
    coordinatorThreadId: "thread-coordinator",
    coordinatorAgentId: "coordinator",
    agentPath: ["coordinator"],
    delegationCount: 0,
  };
  const common = {
    assignment: base({ parentTaskId: "task-one" }),
    coordinatorAgentId: "coordinator",
    sourceRoomId: "room-1",
    sourceTurnId: "turn-one",
    sourceThreadId: "thread-coordinator",
    parentTask: parent,
    agents: [{ id: "coordinator" }, { id: "developer" }],
    assignmentsById: new Map([["assignment-1", base({ parentTaskId: "task-one" })]]),
  };
  assert.equal(validateTaskAssignment(common).reason, "assignment_duplicate");
  const nextParent = { ...parent, id: "task-two", coordinatorTurnId: "turn-two" };
  const next = validateTaskAssignment({
    ...common,
    assignment: base({ parentTaskId: "task-two" }),
    sourceTurnId: "turn-two",
    parentTask: nextParent,
    assignmentsById: new Map(),
  });
  assert.equal(next.ok, true);
});

test("task results retain a strict internal status and sanitize local paths", () => {
  const result = parseTaskResult(formatTaskResult({ assignmentId: "a", parentTaskId: "t", targetAgentId: "developer", sourceTurnId: "turn-1", status: "failed", summary: "G:\\private\\secret.txt" }));
  assert.equal(result.status, "failed");
  assert.match(result.summary, /本机路径已隐藏/);
});

test("task result sanitization removes bearer tokens, prefixed environment secrets, database URLs, and private keys", () => {
  const openAiKeyName = ["OPENAI", "API", "KEY"].join("_");
  const openSshHeader = ["-----BEGIN ", "OPENSSH", " PRIVATE KEY-----"].join("");
  const encryptedHeader = ["-----BEGIN ", "ENCRYPTED", " PRIVATE KEY-----"].join("");
  const source = [
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
    `${openAiKeyName}=sk-live-openai-secret`,
    "DB_PASSWORD='database-password'",
    "X_CLIENT_SECRET=x-client-secret",
    "postgresql://admin:password@db.example.test:5432/app",
    "mongodb+srv://user:pass@cluster.example.test/app",
    `${openSshHeader}\nOPENSSH_PRIVATE_MATERIAL\n-----END OPENSSH PRIVATE KEY-----`,
    `${encryptedHeader}\nENCRYPTED_PRIVATE_MATERIAL\n-----END ENCRYPTED PRIVATE KEY-----`,
  ].join("\n");
  const sanitized = sanitizeTaskText(source);
  for (const secret of [
    "eyJhbGciOiJIUzI1NiJ9.secret.signature",
    "sk-live-openai-secret",
    "database-password",
    "x-client-secret",
    "admin:password",
    "user:pass",
    "OPENSSH_PRIVATE_MATERIAL",
    "ENCRYPTED_PRIVATE_MATERIAL",
    "BEGIN OPENSSH PRIVATE KEY",
    "BEGIN ENCRYPTED PRIVATE KEY",
  ]) assert.doesNotMatch(sanitized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sanitized, /凭据已隐藏/);
  assert.match(sanitized, /数据库地址已隐藏/);
  assert.match(sanitized, /私钥已隐藏/);
});
