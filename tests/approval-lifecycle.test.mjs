import assert from "node:assert/strict";
import test from "node:test";
import {
  applyApprovalLifecycleEvent,
  approvalRoute,
  classifyApprovalRequest,
  createApprovalCommand,
  mergeApprovalCommands,
  reconcileApprovalState,
  visibleApprovalCommands,
} from "../src/lib/approvalLifecycle.js";

const roomId = "room-approval-tests";

function state(agents, commands = [], writeLock = null) {
  return {
    rooms: [{ id: roomId, name: "审批测试", path: "." }],
    agentsByRoom: { [roomId]: agents },
    commandsByRoom: { [roomId]: commands },
    writeLocksByRoom: { [roomId]: writeLock },
  };
}

function request({ agentId, method, command = "读取项目文件", requestId = 0, cwd = "G:\\codexX" } = {}) {
  return { type: "approvalRequested", agentId, method, requestId, command, cwd, threadId: `thread-${agentId}`, turnId: `turn-${agentId}`, itemId: `item-${requestId}` };
}

test("runtime and remote events for one request merge into one stable approval", () => {
  const agents = [{ id: "coordinator", permission: "coordinate", name: "总控" }];
  let current = state(agents);
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: request({ agentId: "coordinator" }) });
  current = applyApprovalLifecycleEvent(current, {
    roomId,
    source: "remote",
    event: { ...request({ agentId: "coordinator", cwd: undefined }), target: "当前项目" },
  });
  const commands = current.commandsByRoom[roomId];
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].originSources.sort(), ["remote", "runtime"]);
  assert.equal(commands[0].approvalKey, commands[0].approvalKey);
});

test("approval cards preserve room and task routing for accept and decline posts", () => {
  const agent = { id: "developer", permission: "request-write", name: "开发" };
  const command = createApprovalCommand({
    roomId,
    source: "remote",
    agent,
    event: { ...request({ agentId: agent.id, method: "item/fileChange/requestApproval", requestId: 17 }), roomId, taskId: "task-route-17" },
  });
  assert.equal(command.roomId, roomId);
  assert.equal(command.taskId, "task-route-17");
  assert.equal(command.agentId, "developer");
  assert.equal(command.threadId, "thread-developer");
  assert.equal(command.turnId, "turn-developer");
});

test("private cloud routes remote approvals and local runtime stays local", () => {
  assert.equal(approvalRoute({ privateCloud: true }), "remote");
  assert.equal(approvalRoute({ privateCloud: false }), "runtime");
  assert.equal(classifyApprovalRequest({ method: "item/commandExecution/requestApproval", agentPermission: "coordinate" }).requiresWriteLock, false);
  const blocked = classifyApprovalRequest({ method: "item/fileChange/requestApproval", agentPermission: "read-only" });
  assert.equal(blocked.canAccept, false);
  assert.equal(blocked.requiresWriteLock, false);
});

test("submitted approvals never create a browser write lock", () => {
  const agent = { id: "developer", permission: "request-write", name: "开发" };
  const command = createApprovalCommand({ roomId, source: "remote", agent, event: request({ agentId: agent.id, method: "item/fileChange/requestApproval" }) });
  const submitted = mergeApprovalCommands([command], [{ ...command, status: "submitted", legacyLifecycle: false }], { roomId });
  const current = state([agent], submitted, null);
  assert.equal(current.commandsByRoom[roomId][0].status, "submitted");
  assert.equal(current.writeLocksByRoom[roomId], null);
});

test("coordinator action blocking cannot create an approval card or lock", () => {
  const agent = { id: "coordinator", permission: "coordinate", name: "总控" };
  let current = state([agent]);
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { type: "coordinatorActionBlocked", agentId: agent.id, reason: "coordinator_must_delegate" } });
  assert.deepEqual(current.commandsByRoom[roomId], []);
  assert.equal(current.writeLocksByRoom[roomId], null);
});

test("write approval acquires a lock only after approvalResolved", () => {
  const agent = { id: "developer", permission: "request-write", name: "开发" };
  let current = state([agent]);
  const pending = request({ agentId: agent.id, method: "item/fileChange/requestApproval", command: "修改项目文件" });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: pending });
  assert.equal(current.writeLocksByRoom[roomId], null);
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { ...pending, type: "approvalResolved", decision: "accept" } });
  assert.equal(current.commandsByRoom[roomId][0].status, "approved");
  assert.equal(current.writeLocksByRoom[roomId].approvalKey, current.commandsByRoom[roomId][0].approvalKey);
});

test("approval failure and disconnect clear active cards and locks", () => {
  const agent = { id: "developer", permission: "request-write", name: "开发" };
  let current = state([agent]);
  const pending = request({ agentId: agent.id, method: "item/fileChange/requestApproval", command: "修改项目文件" });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: pending });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { ...pending, type: "approvalResolved", decision: "accept" } });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { ...pending, type: "approvalFailed", error: "电脑断开" } });
  assert.equal(current.commandsByRoom[roomId][0].status, "failed");
  assert.equal(current.writeLocksByRoom[roomId], null);

  current = state([agent], current.commandsByRoom[roomId], null);
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { type: "runtimeDisconnected" } });
  assert.equal(current.commandsByRoom[roomId][0].status, "failed");
});

test("turn completion expires pending approvals and releases their lock", () => {
  const agent = { id: "developer", permission: "request-write", name: "开发" };
  let current = state([agent]);
  const pending = request({ agentId: agent.id, method: "item/fileChange/requestApproval", command: "修改项目文件" });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: pending });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { ...pending, type: "approvalResolved", decision: "accept" } });
  current = applyApprovalLifecycleEvent(current, { roomId, source: "runtime", event: { ...pending, type: "turnCompleted", status: "cancelled" } });
  assert.equal(current.commandsByRoom[roomId][0].status, "expired");
  assert.equal(current.writeLocksByRoom[roomId], null);
});

test("legacy active cards and orphan locks are removed during generic reconciliation", () => {
  const agent = { id: "coordinator", permission: "coordinate", name: "总控" };
  const legacyRequest = request({ agentId: agent.id, method: "item/commandExecution/requestApproval" });
  const runtime = { id: "runtime-command-0", source: "runtime", ...legacyRequest, status: "pending" };
  const remote = { id: "remote-command-0", source: "remote", ...legacyRequest, target: "当前项目", status: "approved", requiresWriteLock: true };
  const migrated = reconcileApprovalState(state([agent], [runtime, remote], { commandId: "remote-command-0", agentId: agent.id }), { privateCloud: true, runtimeConnected: false });
  assert.equal(migrated.commandsByRoom[roomId].length, 0);
  assert.equal(migrated.writeLocksByRoom[roomId], null);
});

test("only active approvals remain visible in the conversation", () => {
  const commands = [
    { id: "pending", status: "pending" },
    { id: "submitted", status: "submitted" },
    { id: "approved", status: "approved" },
    { id: "completed", status: "completed" },
    { id: "denied", status: "denied" },
    { id: "failed", status: "failed" },
    { id: "expired", status: "expired" },
  ];
  assert.deepEqual(visibleApprovalCommands(commands).map((command) => command.id), ["pending", "submitted", "approved"]);
});
