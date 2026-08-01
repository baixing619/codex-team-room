import assert from "node:assert/strict";
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

test("binds each member model and permission to an independent Codex thread", async () => {
  const harness = createHarness();
  await finishInitialize(harness);
  const agent = { id: "developer", model: "gpt-5.6-sol", reasoning: "high", permission: "request-write" };
  const pending = harness.protocol.startAgentThread(agent, "G:\\project");
  await Promise.resolve();
  const request = harness.sent.at(-1);
  assert.equal(request.method, "thread/start");
  assert.equal(request.params.model, "gpt-5.6-sol");
  assert.equal(request.params.sandbox, "workspaceWrite");
  harness.rpc.receive({ id: request.id, result: { thread: { id: "thread-developer" } } });
  assert.equal((await pending).id, "thread-developer");
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
  assert.deepEqual(request.params.sandboxPolicy.writableRoots, ["G:\\project"]);
  assert.equal(request.params.sandboxPolicy.networkAccess, false);
  harness.rpc.receive({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
  assert.equal((await pending).id, "turn-1");
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
