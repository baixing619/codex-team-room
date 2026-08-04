import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnInput, selectSharedContextForAgent } from "../server/sharedContext.mjs";
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

function countText(source, expected) {
  return String(source).split(expected).length - 1;
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
  const committed = applyContextCursorUpdates({}, Object.fromEntries(Object.entries(first.cursorUpdates).filter(([, cursor]) => cursor.agentId === "developer")), { developer: "thread-developer" });
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
  assert.equal(context.deliveriesByAgentId.reviewer.recovery.mode, "full");
  assert.equal(context.snapshot.recentMessages.length, 2);
});

test("the current request advances ACK fingerprints without being duplicated in its own snapshot or the next delta", () => {
  const currentMessage = { id: "m-current", kind: "user", text: "本轮新请求" };
  const first = buildRoomSharedContext(contextFixture({
    agents: [{ id: "developer", name: "开发", boundThreadId: "thread-developer" }],
    activeAgentIds: ["developer"],
    currentMessage,
  }));
  assert.equal(first.snapshot.recentMessages.some((message) => message.id === "m-current"), false);
  assert.ok(first.cursorUpdates["thread:thread-developer"].messageFingerprints["m-current"]);

  const committed = applyContextCursorUpdates({}, first.cursorUpdates, { developer: "thread-developer" });
  const next = buildRoomSharedContext(contextFixture({
    agents: [{ id: "developer", name: "开发", boundThreadId: "thread-developer" }],
    activeAgentIds: ["developer"],
    memberCursors: committed,
    messages: [...contextFixture().messages, currentMessage],
  }));
  assert.equal(next.deliveriesByAgentId.developer.mode, "delta");
  assert.deepEqual(next.deliveriesByAgentId.developer.recentMessages, []);
});

test("a deferred member keeps a pending cursor update and can recover an existing-thread delta when later delegated", () => {
  const first = buildRoomSharedContext(contextFixture());
  const committed = applyContextCursorUpdates({}, first.cursorUpdates, { developer: "thread-developer", reviewer: "thread-reviewer" });
  const next = buildRoomSharedContext(contextFixture({
    memberCursors: committed,
    activeAgentIds: ["developer"],
    messages: [...contextFixture().messages, { id: "m-delegated", kind: "user", text: "只在委派时补发" }],
  }));
  assert.equal(next.deliveriesByAgentId.reviewer.mode, "deferred");
  assert.equal(next.deliveriesByAgentId.reviewer.recovery.mode, "delta");
  assert.deepEqual(next.deliveriesByAgentId.reviewer.recovery.recentMessages.map((message) => message.id), ["m-delegated"]);
  assert.equal(next.cursorUpdates["thread:thread-reviewer"].agentId, "reviewer");
});

test("deferred full and delta recovery deliver the current request once when delegated and never resend it after ACK", () => {
  const developer = { id: "developer", name: "开发", boundThreadId: "thread-developer" };
  const currentMessage = { id: "m-current-delegated", kind: "user", text: "CURRENT_DEFERRED_REQUEST_EXACTLY_ONCE" };

  for (const developerMode of ["full", "delta"]) {
    let memberCursors = {};
    if (developerMode === "delta") {
      const seed = buildRoomSharedContext(contextFixture({ agents: [developer], activeAgentIds: ["developer"] }));
      memberCursors = applyContextCursorUpdates({}, seed.cursorUpdates, { developer: "thread-developer" });
    }
    const context = buildRoomSharedContext(contextFixture({
      contextId: `context-current-${developerMode}`,
      agents: [developer],
      activeAgentIds: [],
      memberCursors,
      text: "请总控安排开发处理",
      currentMessage,
    }));
    const recovery = context.deliveriesByAgentId.developer.recovery;
    assert.equal(recovery.mode, developerMode);
    assert.equal(recovery.currentMessage.text, currentMessage.text);

    const delegatedContext = selectSharedContextForAgent(context, "developer", { includeDeferredCurrentMessage: true });
    const delegatedMessages = buildTurnInput({
      text: "你收到当前项目总控的真实委派。",
      sharedContext: delegatedContext,
    }).map((item) => item.text || "").join("\n");
    assert.equal(countText(delegatedMessages, currentMessage.text), 1, `${developerMode} delegated recovery`);

    const promotedContext = selectSharedContextForAgent(context, "developer", { includeDeferredCurrentMessage: false });
    const promotedMessages = buildTurnInput({
      text: currentMessage.text,
      sharedContext: promotedContext,
    }).map((item) => item.text || "").join("\n");
    assert.equal(countText(promotedMessages, currentMessage.text), 1, `${developerMode} initial promotion`);

    const acknowledged = applyContextCursorUpdates(memberCursors, context.cursorUpdates, { developer: "thread-developer" });
    const nextMessage = { id: `m-next-${developerMode}`, kind: "user", text: `NEXT_REQUEST_${developerMode.toUpperCase()}` };
    const next = buildRoomSharedContext(contextFixture({
      contextId: `context-after-ack-${developerMode}`,
      agents: [developer],
      activeAgentIds: ["developer"],
      memberCursors: acknowledged,
      messages: [...contextFixture().messages, currentMessage],
      text: nextMessage.text,
      currentMessage: nextMessage,
    }));
    const nextContext = selectSharedContextForAgent(next, "developer");
    const nextMessages = buildTurnInput({ text: nextMessage.text, sharedContext: nextContext })
      .map((item) => item.text || "").join("\n");
    assert.equal(next.deliveriesByAgentId.developer.mode, "delta");
    assert.equal(countText(nextMessages, currentMessage.text), 0, `${developerMode} after ACK`);
    assert.equal(countText(nextMessages, nextMessage.text), 1, `${developerMode} next request`);
  }
});

test("deferred recovery keeps repeated user text when the message ids differ", () => {
  const developer = { id: "developer", name: "开发", boundThreadId: "thread-developer" };
  const messages = [
    { id: "m-old", kind: "user", text: "继续" },
    { id: "m-after-old", kind: "agent", agentId: "developer", text: "上一轮已处理" },
  ];
  const currentMessage = { id: "m-new", kind: "user", text: "继续" };

  for (const developerMode of ["full", "delta"]) {
    let memberCursors = {};
    if (developerMode === "delta") {
      const seed = buildRoomSharedContext(contextFixture({ agents: [developer], activeAgentIds: ["developer"], messages }));
      memberCursors = applyContextCursorUpdates({}, seed.cursorUpdates, { developer: "thread-developer" });
    }
    const context = buildRoomSharedContext(contextFixture({
      contextId: `context-repeat-${developerMode}`,
      agents: [developer],
      activeAgentIds: [],
      memberCursors,
      messages,
      text: "请总控安排开发继续处理",
      currentMessage,
    }));
    const delivered = selectSharedContextForAgent(context, "developer", { includeDeferredCurrentMessage: true });
    const deliveredIds = delivered.recentMessages.map((message) => message.id);
    assert.equal(deliveredIds.filter((id) => id === "m-new").length, 1, `${developerMode} keeps the new id`);
    if (developerMode === "full") assert.ok(deliveredIds.includes("m-old"));
  }
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
