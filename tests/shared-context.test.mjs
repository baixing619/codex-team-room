import assert from "node:assert/strict";
import test from "node:test";
import { formatSharedContext, selectSharedContextForAgent } from "../server/sharedContext.mjs";

test("empty delta context explains that nothing was added instead of implying an empty project", () => {
  const text = formatSharedContext({ id: "context-delta-empty", roomId: "room-one", roomName: "项目", mode: "delta", knowledge: [], recentMessages: [] });

  assert.match(text, /本轮无新增公共知识/);
  assert.match(text, /本轮无新增团队消息/);
  assert.doesNotMatch(text, /暂无公共知识/);
  assert.doesNotMatch(text, /暂无近期团队消息/);
});

test("legacy V1 payloads still format and select as complete contexts", () => {
  const legacy = {
    id: "context-v1",
    roomId: "room-one",
    roomName: "旧项目",
    knowledge: [{ id: "k1", title: "旧知识", category: "项目知识", body: "旧知识正文" }],
    recentMessages: [{ id: "m1", role: "user", text: "旧团队消息" }],
  };
  const selected = selectSharedContextForAgent(legacy, "developer");

  assert.equal(selected, legacy);
  assert.match(formatSharedContext(selected), /旧知识正文/);
  assert.match(formatSharedContext(selected), /旧团队消息/);
});

test("a deferred member promoted by runtime receives the available full snapshot", () => {
  const structured = {
    id: "context-recovery",
    roomId: "room-one",
    roomName: "项目",
    snapshot: {
      knowledge: [{ id: "k1", title: "恢复知识", body: "完整恢复正文" }],
      recentMessages: [{ id: "m1", role: "user", text: "完整恢复消息" }],
    },
    deliveriesByAgentId: { reviewer: { mode: "deferred", cursorKey: "agent:reviewer" } },
  };
  const selected = selectSharedContextForAgent(structured, "reviewer");

  assert.equal(selected.mode, "full");
  assert.equal(selected.knowledge[0].body, "完整恢复正文");
  assert.equal(selected.recentMessages[0].text, "完整恢复消息");
});

test("a malformed deferred promotion fails before sending an empty context", () => {
  assert.throws(
    () => selectSharedContextForAgent({ id: "context-missing-snapshot", deliveriesByAgentId: { reviewer: { mode: "deferred" } } }, "reviewer"),
    /shared_context_recovery_snapshot_required/,
  );
});
