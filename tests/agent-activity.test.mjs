import assert from "node:assert/strict";
import test from "node:test";
import { reduceAgentActivity } from "../src/lib/agentActivity.js";

function reduce(events, initial = {}) {
  return events.reduce(reduceAgentActivity, initial);
}

test("member activity starts only from a real turn and follows its matching lifecycle", () => {
  const ignored = reduce([
    { type: "taskStarted", roomId: "room-1", taskId: "task-1", agentId: "developer" },
    { type: "participationDecided", roomId: "room-1", taskId: "task-1", agentId: "developer", decision: "speak" },
  ]);
  assert.deepEqual(ignored, {});

  const started = reduceAgentActivity(ignored, {
    type: "turnStarted",
    roomId: "room-1",
    taskId: "task-1",
    agentId: "developer",
    turnId: "turn-1",
    turnKind: "delegatedTarget",
    assignmentId: "assignment-1",
  });
  assert.deepEqual(started["room-1"].developer, {
    active: true,
    status: "received",
    label: "已收到总控委派",
    taskId: "task-1",
    turnId: "turn-1",
    turnKind: "delegatedTarget",
    assignmentId: "assignment-1",
    assignmentPhase: null,
  });

  const working = reduceAgentActivity(started, {
    type: "turnProgress",
    roomId: "room-1",
    taskId: "task-1",
    agentId: "developer",
    turnId: "turn-1",
    stage: "working",
  });
  assert.equal(working["room-1"].developer.active, true);
  assert.equal(working["room-1"].developer.status, "working");
  assert.equal(working["room-1"].developer.label, "正在执行总控委派");

  const completed = reduceAgentActivity(working, {
    type: "turnCompleted",
    roomId: "room-1",
    taskId: "task-1",
    agentId: "developer",
    turnId: "turn-1",
    status: "completed",
  });
  assert.equal(completed["room-1"].developer.active, false);
  assert.equal(completed["room-1"].developer.status, "completed");
  assert.equal(completed["room-1"].developer.label, "本轮已完成");
});

test("late progress and completion from an older turn cannot alter a newer turn", () => {
  const current = reduce([
    { type: "turnStarted", roomId: "room-1", taskId: "task-old", agentId: "developer", turnId: "turn-old", turnKind: "initial" },
    { type: "turnStarted", roomId: "room-1", taskId: "task-new", agentId: "developer", turnId: "turn-new", turnKind: "initial" },
  ]);

  const lateProgress = reduceAgentActivity(current, { type: "turnProgress", roomId: "room-1", taskId: "task-old", agentId: "developer", turnId: "turn-old", stage: "working" });
  const lateCompletion = reduceAgentActivity(lateProgress, { type: "turnCompleted", roomId: "room-1", taskId: "task-old", agentId: "developer", turnId: "turn-old", status: "completed" });

  assert.strictEqual(lateProgress, current);
  assert.strictEqual(lateCompletion, current);
  assert.equal(lateCompletion["room-1"].developer.turnId, "turn-new");
  assert.equal(lateCompletion["room-1"].developer.active, true);
});

test("task terminal events clear only their task and runtime disconnect clears only its room", () => {
  const active = reduce([
    { type: "turnStarted", roomId: "room-1", taskId: "task-a", agentId: "developer", turnId: "turn-a", turnKind: "initial" },
    { type: "turnStarted", roomId: "room-1", taskId: "task-b", agentId: "reviewer", turnId: "turn-b", turnKind: "delegatedTarget", assignmentPhase: "working" },
    { type: "turnStarted", roomId: "room-2", taskId: "task-a", agentId: "researcher", turnId: "turn-c", turnKind: "finalSummary" },
  ]);
  assert.equal(active["room-1"].reviewer.label, "正在执行总控委派");
  assert.equal(active["room-2"].researcher.label, "已收到成员结果，准备汇总");

  const taskEnded = reduceAgentActivity(active, { type: "taskFailed", roomId: "room-1", taskId: "task-a" });
  assert.equal(taskEnded["room-1"].developer, undefined);
  assert.equal(taskEnded["room-1"].reviewer.active, true);
  assert.equal(taskEnded["room-2"].researcher.active, true);

  const disconnected = reduceAgentActivity(taskEnded, { type: "runtimeDisconnected", roomId: "room-1" });
  assert.equal(disconnected["room-1"], undefined);
  assert.equal(disconnected["room-2"].researcher.active, true);
});
