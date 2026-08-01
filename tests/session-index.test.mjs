import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("indexes metadata and exposes only visible user and assistant messages", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: "thread-1", thread_name: "测试对话", updated_at: "2026-08-01T10:00:00Z" })}\n`);
  fs.writeFileSync(
    path.join(sessions, "rollout-test.jsonl"),
    [
      { type: "session_meta", payload: { id: "thread-1", cwd: "G:\\\\demo", timestamp: "2026-08-01T09:00:00Z" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<app-context>secret internal context</app-context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_delegation>private coordination metadata</codex_delegation>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "这是用户可见消息" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "这是助手回复" }] } },
    ].map((item) => JSON.stringify(item)).join("\n"),
  );

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?test=${Date.now()}`);
  const projects = indexModule.listProjects();
  const result = indexModule.readVisibleMessages("thread-1");

  assert.equal(projects.length, 1);
  assert.equal(projects[0].threadCount, 1);
  assert.deepEqual(result.messages.map((message) => message.text), ["这是用户可见消息", "这是助手回复"]);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
