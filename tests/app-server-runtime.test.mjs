import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerProtocol, JsonLineRpcClient, npmCodexBinaryCandidate } from "../server/codexAppServerRuntime.mjs";

function createHarness() {
  const sent = [];
  const rpc = new JsonLineRpcClient({ send: (line) => sent.push(JSON.parse(line)) });
  return { sent, rpc, protocol: new CodexAppServerProtocol(rpc) };
}

async function finishInitialize(harness) {
  const pending = harness.protocol.initialize();
  assert.equal(harness.sent[0].method, "initialize");
  harness.rpc.receive({ id: harness.sent[0].id, result: { platformFamily: "windows" } });
  await pending;
  assert.equal(harness.sent[1].method, "initialized");
}

test("binds each member model, permission, and system prompt to an independent Codex thread", async () => {
  const harness = createHarness();
  await finishInitialize(harness);
  const agent = { id: "developer", model: "gpt-5.6-sol", reasoning: "high", permission: "request-write", systemPrompt: "只处理当前项目" };
  const pending = harness.protocol.startAgentThread(agent, "G:\\project");
  await Promise.resolve();
  const request = harness.sent.at(-1);
  assert.equal(request.method, "thread/start");
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.sandbox, "workspace-write");
  assert.equal(request.params.developerInstructions, "只处理当前项目");
  harness.rpc.receive({ id: request.id, result: { thread: { id: "thread-developer" } } });
  assert.equal((await pending).id, "thread-developer");
});

test("resuming a selected thread reapplies its project cwd and member system prompt", async () => {
  const harness = createHarness();
  await finishInitialize(harness);
  const agent = { id: "developer", model: "gpt-5.6-terra", reasoning: "high", permission: "read-only", systemPrompt: "不要读取其他项目" };
  const pending = harness.protocol.resumeAgentThread("thread-existing", agent, "G:\\project");
  await Promise.resolve();
  const request = harness.sent.at(-1);
  assert.equal(request.method, "thread/resume");
  assert.equal(request.params.threadId, "thread-existing");
  assert.equal(request.params.cwd, "G:\\project");
  assert.equal(request.params.sandbox, "read-only");
  assert.equal(request.params.developerInstructions, "不要读取其他项目");
  harness.rpc.receive({ id: request.id, result: { thread: { id: "thread-existing" } } });
  assert.equal((await pending).id, "thread-existing");
});

test("turn overrides keep model, effort, workspace root, and network denial together", async () => {
  const harness = createHarness();
  await finishInitialize(harness);
  const agent = { id: "developer", model: "gpt-5.6-sol", reasoning: "xhigh", permission: "request-write" };
  const pending = harness.protocol.startAgentTurn({
    threadId: "thread-developer",
    agent,
    cwd: "G:\\project",
    text: "运行测试",
    clientUserMessageId: "room-message-1",
  });
  await Promise.resolve();
  const request = harness.sent.at(-1);
  assert.equal(request.method, "turn/start");
  assert.equal(request.params.effort, "xhigh");
  assert.equal(request.params.approvalPolicy, "untrusted");
  assert.deepEqual(request.params.sandboxPolicy.writableRoots, ["G:\\project"]);
  assert.equal(request.params.sandboxPolicy.networkAccess, false);
  harness.rpc.receive({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
  assert.equal((await pending).id, "turn-1");
});

test("a real turn carries traceable shared context and protocol-native attachments", async () => {
  const harness = createHarness();
  await finishInitialize(harness);
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-input-test-"));
  const textPath = path.join(tempDirectory, "requirements.txt");
  fs.writeFileSync(textPath, "TEAM_ROOM_FILE_CONTENT", "utf8");
  const pending = harness.protocol.startAgentTurn({
    threadId: "thread-reviewer",
    agent: { id: "reviewer", model: "gpt-5.6-terra", reasoning: "high", permission: "read-only" },
    cwd: "G:\\project",
    text: "复核开发结论",
    clientUserMessageId: "room-message-context",
    sharedContext: {
      id: "context-proof-1",
      roomId: "room-proof",
      roomName: "真实项目",
      knowledge: [{ title: "验收标准", category: "项目知识", body: "必须通过真实运行时" }],
      recentMessages: [{ role: "agent", agentName: "开发", sourceThreadId: "thread-developer", text: "实现已经完成" }],
    },
    attachments: [
      { name: "screen.png", type: "image/png", path: "G:\\temp\\screen.png" },
      { name: "requirements.txt", type: "text/plain", path: textPath },
    ],
  });
  await Promise.resolve();
  const request = harness.sent.at(-1);
  assert.equal(request.method, "turn/start");
  assert.match(request.params.input[0].text, /TEAM_ROOM_SHARED_CONTEXT_V1/);
  assert.match(request.params.input[0].text, /上下文标识：context-proof-1/);
  assert.match(request.params.input[0].text, /成员 开发 \/ 对话 thread-developer/);
  assert.match(request.params.input[0].text, /用户当前请求：\n复核开发结论/);
  assert.deepEqual(request.params.input[1], { type: "localImage", path: "G:\\temp\\screen.png" });
  assert.match(request.params.input[2].text, /TEAM_ROOM_TEXT_ATTACHMENT/);
  assert.match(request.params.input[2].text, /TEAM_ROOM_FILE_CONTENT/);
  harness.rpc.receive({ id: request.id, result: { turn: { id: "turn-context", status: "inProgress" } } });
  assert.equal((await pending).id, "turn-context");
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test("approval responses allow one-time accept but reject session-wide grants", async () => {
  const harness = createHarness();
  harness.rpc.receive({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1" } });
  harness.protocol.resolveApproval(77, "accept");
  assert.deepEqual(harness.sent.at(-1), { id: 77, result: { decision: "accept" } });

  harness.rpc.receive({ id: 78, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1" } });
  assert.throws(() => harness.protocol.resolveApproval(78, "acceptForSession"), /one-time accept/);
});

test("resolves the official npm Codex binary on native Windows", () => {
  assert.equal(
    npmCodexBinaryCandidate({ appData: "C:\\Users\\demo\\AppData\\Roaming", arch: "x64" }),
    "C:\\Users\\demo\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
  );
  assert.equal(npmCodexBinaryCandidate({ appData: "C:\\Users\\demo", arch: "ia32" }), null);
});
