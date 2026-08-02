import assert from "node:assert/strict";
import test from "node:test";
import { applyContextCursorUpdates } from "../src/lib/contextCursors.js";
import { buildRoomSharedContext, isSupportedAttachment, MAX_ATTACHMENTS, validateSelectedFiles } from "../src/lib/taskPayload.js";

test("browser payload preserves member and source conversation identity", () => {
  const context = buildRoomSharedContext({
    room: { id: "room-one", name: "产品项目" },
    contextId: "context-browser-proof",
    agents: [{ id: "developer", name: "开发" }],
    knowledge: [{ id: "k1", title: "目标", category: "项目知识", body: "做真实产品" }],
    messages: [{ id: "m1", kind: "agent", agentId: "developer", threadId: "thread-developer-real", text: "后端已经验证" }],
  });
  assert.equal(context.id, "context-browser-proof");
  assert.deepEqual(context.snapshot.recentMessages[0], {
    id: "m1",
    role: "agent",
    agentId: "developer",
    agentName: "开发",
    sourceThreadId: "thread-developer-real",
    text: "后端已经验证",
  });
  assert.equal(context.deliveriesByAgentId.developer.mode, "full");
});

function contextFixture(overrides = {}) {
  return {
    room: { id: "room-one", name: "产品项目" },
    contextId: "context-proof",
    agents: [
      { id: "developer", name: "开发", boundThreadId: "thread-developer" },
      { id: "reviewer", name: "审核", boundThreadId: "thread-reviewer" },
    ],
    knowledge: [{ id: "k-old", title: "目标", category: "项目知识", body: "旧目标" }],
    messages: [
      { id: "m-old", kind: "user", text: "旧团队消息" },
      { id: "m-check", kind: "agent", agentId: "reviewer", threadId: "thread-reviewer", text: "旧审核结论" },
    ],
    activeAgentIds: ["developer", "reviewer"],
    ...overrides,
  };
}

test("the same member receives a full snapshot once, then only new messages", () => {
  const first = buildRoomSharedContext(contextFixture({ agents: [{ id: "developer", name: "开发" }] }));
  const committed = applyContextCursorUpdates({}, first.cursorUpdates, { developer: "thread-developer" });
  const second = buildRoomSharedContext(contextFixture({
    agents: [{ id: "developer", name: "开发", boundThreadId: "thread-developer" }],
    messages: [...contextFixture().messages, { id: "m-new", kind: "user", text: "新团队消息" }],
    memberCursors: committed,
    activeAgentIds: ["developer"],
  }));

  assert.equal(first.deliveriesByAgentId.developer.mode, "full");
  assert.equal(second.snapshot, null);
  assert.equal(second.deliveriesByAgentId.developer.mode, "delta");
  assert.deepEqual(second.deliveriesByAgentId.developer.recentMessages.map((item) => item.id), ["m-new"]);
  assert.equal(second.deliveriesByAgentId.developer.knowledge.length, 0);
});

test("a late member gets the complete snapshot while an existing thread gets a delta", () => {
  const first = buildRoomSharedContext(contextFixture({ activeAgentIds: ["developer"] }));
  const committed = applyContextCursorUpdates({}, first.cursorUpdates, { developer: "thread-developer" });
  const next = buildRoomSharedContext(contextFixture({
    memberCursors: committed,
    agents: [
      { id: "developer", name: "开发", boundThreadId: "thread-developer" },
      { id: "reviewer", name: "审核", boundThreadId: "thread-reviewer" },
    ],
  }));

  assert.equal(next.deliveriesByAgentId.developer.mode, "delta");
  assert.equal(next.deliveriesByAgentId.reviewer.mode, "full");
  assert.deepEqual(next.snapshot.recentMessages.map((item) => item.id), ["m-old", "m-check"]);
  assert.equal(next.deliveriesByAgentId.developer.recentMessages.length, 0);
});

test("knowledge edits and new mounted history are sent as structured deltas", () => {
  const first = buildRoomSharedContext(contextFixture({ agents: [{ id: "developer", name: "开发" }] }));
  const committed = applyContextCursorUpdates({}, first.cursorUpdates, { developer: "thread-developer" });
  const next = buildRoomSharedContext(contextFixture({
    agents: [{ id: "developer", name: "开发", boundThreadId: "thread-developer" }],
    memberCursors: committed,
    knowledge: [
      { id: "k-old", title: "目标", category: "项目知识", body: "已更新目标" },
      { id: "k-history", title: "挂载历史", category: "历史对话", body: "新增的历史正文" },
    ],
    activeAgentIds: ["developer"],
  }));

  assert.deepEqual(next.deliveriesByAgentId.developer.knowledge.map((item) => item.id), ["k-old", "k-history"]);
  assert.deepEqual(next.deliveriesByAgentId.developer.recentMessages, []);

  const deleted = buildRoomSharedContext(contextFixture({
    agents: [{ id: "developer", name: "开发", boundThreadId: "thread-developer" }],
    memberCursors: committed,
    knowledge: [{ id: "k-history", title: "挂载历史", category: "历史对话", body: "新增的历史正文" }],
    activeAgentIds: ["developer"],
  }));
  assert.deepEqual(deleted.deliveriesByAgentId.developer.removedKnowledgeIds, ["k-old"]);
});

test("an explicitly mentioned deferred member gets a recovery snapshot in the payload", () => {
  const context = buildRoomSharedContext(contextFixture({ activeAgentIds: [], text: "@审核 请回复" }));

  assert.ok(context.snapshot);
  assert.equal(context.deliveriesByAgentId.reviewer.mode, "deferred");
  assert.equal(context.snapshot.recentMessages.length, 2);
});

test("each member keeps an independent cursor and a failed send does not advance either one", () => {
  const first = buildRoomSharedContext(contextFixture());
  const retryWithoutAck = buildRoomSharedContext(contextFixture({ messages: [...contextFixture().messages, { id: "m-new", kind: "user", text: "重试消息" }] }));
  assert.equal(retryWithoutAck.deliveriesByAgentId.developer.mode, "full");
  assert.equal(retryWithoutAck.deliveriesByAgentId.reviewer.mode, "full");

  const committed = applyContextCursorUpdates({}, first.cursorUpdates, {
    developer: "thread-developer",
    reviewer: "thread-reviewer",
  });
  const next = buildRoomSharedContext(contextFixture({
    memberCursors: committed,
    messages: [...contextFixture().messages, { id: "m-new", kind: "user", text: "新消息" }],
  }));
  assert.equal(next.deliveriesByAgentId.developer.mode, "delta");
  assert.equal(next.deliveriesByAgentId.reviewer.mode, "delta");
  assert.deepEqual(next.deliveriesByAgentId.developer.recentMessages.map((item) => item.id), ["m-new"]);
  assert.deepEqual(next.deliveriesByAgentId.reviewer.recentMessages.map((item) => item.id), ["m-new"]);
});

test("browser attachment validation enforces count and size before uploading", () => {
  const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => ({ name: `file-${index}.txt`, size: 10 }));
  const countResult = validateSelectedFiles(files);
  assert.equal(countResult.accepted.length, MAX_ATTACHMENTS);
  assert.match(countResult.errors[0], /最多/);
  const sizeResult = validateSelectedFiles([{ name: "huge.bin", size: 10 * 1024 * 1024 + 1 }]);
  assert.equal(sizeResult.accepted.length, 0);
  assert.match(sizeResult.errors[0], /超过 10 MB/);
});

test("attachment picker accepts native media and inline text but rejects unsupported binaries", () => {
  assert.equal(isSupportedAttachment({ name: "photo.png", type: "image/png" }), true);
  assert.equal(isSupportedAttachment({ name: "notes.md", type: "" }), true);
  assert.equal(isSupportedAttachment({ name: "report.pdf", type: "application/pdf" }), false);
  const result = validateSelectedFiles([{ name: "report.pdf", type: "application/pdf", size: 100 }]);
  assert.equal(result.accepted.length, 0);
  assert.match(result.errors[0], /暂不支持/);
});
