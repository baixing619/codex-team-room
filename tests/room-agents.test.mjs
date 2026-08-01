import assert from "node:assert/strict";
import test from "node:test";
import { addRoomMember, createProjectMember, createSafeMemberPrompt, isCorruptedThreadTitle, migrateTeamRoomState, removeRoomMember, STATE_SCHEMA_VERSION } from "../src/lib/roomAgents.js";

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
  assert.equal(migrated.writeLocksByRoom["room-a"].commandId, "old-command");
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
        { id: "valid", title: "是不是这样？", kind: "codex" },
      ],
    },
  });

  assert.deepEqual(migrated.threadCache["room-a"].map((thread) => thread.id), ["global", "valid"]);
  assert.equal(isCorruptedThreadTitle("?? ??"), true);
  assert.equal(isCorruptedThreadTitle("问题？"), false);
  assert.equal(isCorruptedThreadTitle("?"), false);
});
