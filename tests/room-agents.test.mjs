import assert from "node:assert/strict";
import test from "node:test";
import { addRoomMember, createProjectMember, createSafeMemberPrompt, isCorruptedThreadTitle, migrateTeamRoomState, removeRoomMember, sanitizeHistoryCache, sanitizeRoomMessages, STATE_SCHEMA_VERSION } from "../src/lib/roomAgents.js";

test("migrates legacy global members into independent per-room copies", () => {
  const migrated = migrateTeamRoomState({
    schemaVersion: 1,
    rooms: [{ id: "room-a", name: "项目 A" }, { id: "room-b", name: "项目 B" }],
    activeRoomId: "room-a",
    agents: [{ id: "developer", name: "开发", role: "工程师", runtimeThreadId: "old-runtime-thread" }],
    writeLock: { agentId: "developer", commandId: "old-command" },
  });

  assert.equal(migrated.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(migrated.agents, undefined);
  assert.notEqual(migrated.agentsByRoom["room-a"], migrated.agentsByRoom["room-b"]);
  assert.equal(migrated.agentsByRoom["room-a"][0].runtimeThreadId, undefined);
  assert.equal(migrated.agentsByRoom["room-a"][0].threadBinding, "auto");
  assert.equal(migrated.writeLocksByRoom["room-a"], null);
  assert.equal(migrated.writeLocksByRoom["room-b"], null);

  migrated.agentsByRoom["room-a"][0].name = "只改 A";
  assert.equal(migrated.agentsByRoom["room-b"][0].name, "开发");
});

test("new project member receives a safe prompt derived from its name and role", () => {
  const member = createProjectMember({ id: "member-test", name: "资料员", role: "资料核验" });

  assert.equal(member.id, "member-test");
  assert.equal(member.threadBinding, "auto");
  assert.equal(member.boundThreadId, null);
  assert.match(member.systemPrompt, /资料员/);
  assert.match(member.systemPrompt, /资料核验/);
  assert.match(member.systemPrompt, /不要读取、泄露或转发其他项目/);
  assert.equal(createSafeMemberPrompt({ name: "审核", role: "风险复核" }).includes("风险复核"), true);
});

test("adding or removing a member only changes the target room list", () => {
  const projectA = [{ id: "a", name: "A 成员", role: "开发", systemPrompt: "A" }];
  const projectB = [{ id: "b", name: "B 成员", role: "审核", systemPrompt: "B" }];
  const newMember = createProjectMember({ id: "new", name: "新资料", role: "资料核验" });
  const changedA = removeRoomMember(addRoomMember(projectA, newMember), "a");

  assert.deepEqual(changedA.map((member) => member.id), ["new"]);
  assert.deepEqual(projectA.map((member) => member.id), ["a"]);
  assert.deepEqual(projectB.map((member) => member.id), ["b"]);
});

test("migration removes only cached thread titles corrupted into question marks", () => {
  const migrated = migrateTeamRoomState({
    rooms: [{ id: "room-a", name: "项目 A" }],
    activeRoomId: "room-a",
    threadCache: {
      "room-a": [
        { id: "global", title: "团队调度台", kind: "room" },
        { id: "broken", title: "??????", kind: "codex" },
        { id: "internal", title: "[TEAM_ROOM_SHARED_CONTEXT_V1] 上下文标识：internal", kind: "codex" },
        { id: "subagent", title: "Jason · review", kind: "codex", source: { subagent: { thread_spawn: { parent_thread_id: "valid" } } } },
        { id: "valid", title: "是不是这样？", kind: "codex" },
      ],
    },
  });

  assert.deepEqual(migrated.threadCache["room-a"].map((thread) => thread.id), ["global", "internal", "valid"]);
  assert.equal(isCorruptedThreadTitle("?? ??"), true);
  assert.equal(isCorruptedThreadTitle("问题？"), false);
  assert.equal(isCorruptedThreadTitle("?"), false);
});

test("migration collapses the local and remote copies of one agent event", () => {
  const messages = sanitizeRoomMessages([
    { id: "runtime-message-31", kind: "agent", agentId: "coordinator", threadId: "thread-1", time: "03:49", text: "同一条真实成员回复" },
    { id: "remote-message-31", kind: "agent", agentId: "coordinator", threadId: "thread-1", time: "00:39", text: "同一条真实成员回复" },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "remote-message-31");
  assert.equal(messages[0].time, "03:49");
});

test("history cache survives refresh migration while bounding stored transcript text", () => {
  const cached = sanitizeHistoryCache({
    "thread-1": {
      thread: { id: "thread-1", title: "真实历史对话" },
      roomId: "room-a",
      cachedAt: "2026-08-02T00:00:00.000Z",
      messages: [{ id: "message-1", role: "user", text: "a".repeat(10_000) }],
    },
  });

  assert.equal(cached["thread-1"].thread.title, "真实历史对话");
  assert.equal(cached["thread-1"].roomId, "room-a");
  assert.equal(cached["thread-1"].messages[0].text.length, 8_000);
  assert.equal(migrateTeamRoomState({ historyCacheByThread: cached }).historyCacheByThread["thread-1"].messages.length, 1);
});
