import assert from "node:assert/strict";
import test from "node:test";
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
  assert.deepEqual(context.recentMessages[0], {
    id: "m1",
    role: "agent",
    agentId: "developer",
    agentName: "开发",
    sourceThreadId: "thread-developer-real",
    text: "后端已经验证",
  });
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
