import assert from "node:assert/strict";
import test from "node:test";
import { RemotePairingBridge, sanitizeRuntimeEvent } from "../server/remotePairingBridge.mjs";

test("runtime events sent to the private site do not expose local paths or command output", () => {
  const sanitized = sanitizeRuntimeEvent({
    sequence: 9,
    type: "writeItemCompleted",
    createdAt: "2026-08-01T00:00:00.000Z",
    agentId: "developer",
    threadId: "thread-1",
    cwd: "G:\\private-project",
    item: { type: "commandExecution", status: "completed", aggregatedOutput: "private output" },
  });

  assert.equal(sanitized.cwd, undefined);
  assert.deepEqual(sanitized.item, { type: "commandExecution", status: "completed" });
});

test("outbound bridge dispatches queued work and applies one-time approvals", async () => {
  const calls = [];
  const runtime = {
    connectCalls: [],
    dispatchCalls: [],
    approvalCalls: [],
    async connect(value) { this.connectCalls.push(value); },
    async dispatch(value) { this.dispatchCalls.push(value); },
    resolveApproval(value) { this.approvalCalls.push(value); },
    listEvents() { return [{ sequence: 1, type: "agentMessage", agentId: "coordinator", text: "已完成" }]; },
  };
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (pathname === "/api/device/tasks") return Response.json({ task: { id: "task-1", cwd: "G:\\project-two", text: "开始", message_id: "message-1", decisions: [{ agentId: "coordinator", decision: "speak" }], agents: [{ id: "coordinator" }] } });
    if (pathname === "/api/device/approvals") return Response.json({ approval: { id: "approval-1", request_id: "42", decision: "accept" } });
    if (pathname === "/api/device/index-requests") return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ ok: true });
  };
  const bridge = new RemotePairingBridge({
    runtime,
    fetchImpl,
    indexProvider: { listProjects: () => [{ path: "G:\\project-two", exists: true }] },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };

  await bridge.tick();

  assert.equal(runtime.connectCalls[0].confirmed, true);
  assert.equal(runtime.connectCalls[0].cwd, "G:\\project-two");
  assert.equal(runtime.dispatchCalls[0].text, "开始");
  assert.deepEqual(runtime.approvalCalls, [{ requestId: 42, decision: "accept" }]);
  assert.ok(calls.some((call) => call.pathname === "/api/device/events"));
  assert.ok(calls.every((call) => call.options.headers["x-team-room-device-secret"] === "device-secret"));
  assert.ok(calls.every((call) => call.options.headers["OAI-Sites-Authorization"] === "Bearer bypass-token"));
  assert.equal(bridge.lastError, null);
});

test("paired bridge reads project metadata only when the private site requests it", async () => {
  let uploadedResult = null;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/device/tasks") return Response.json({ task: null });
    if (pathname === "/api/device/approvals") return Response.json({ approval: null });
    if (pathname === "/api/device/index-requests") {
      return Response.json({ indexRequest: { id: "index-1", request_type: "projects", request: {} } });
    }
    if (pathname === "/api/device/index-requests/index-1/result") {
      uploadedResult = JSON.parse(options.body);
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true });
  };
  const bridge = new RemotePairingBridge({
    runtime: { listEvents: () => [] },
    fetchImpl,
    indexProvider: {
      listProjects: () => [{ name: "动画项目", path: "G:\\animation", threadCount: 3, exists: true }],
      listThreads: () => [],
      readVisibleMessages: () => null,
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };
  bridge.lastHeartbeatAt = Date.now();

  await bridge.tick();

  assert.equal(uploadedResult.ok, true);
  assert.deepEqual(uploadedResult.result.projects, [{ name: "动画项目", path: "G:\\animation", threadCount: 3, exists: true }]);
});

test("Windows-native request fallback handles a Cloudflare block without exposing a second API", async () => {
  const nativeCalls = [];
  const bridge = new RemotePairingBridge({
    runtime: {},
    fetchImpl: async () => new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }),
    nativeRequestImpl: async (url, options) => {
      nativeCalls.push({ url, options });
      return Response.json({ task: null });
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token" };

  const value = await bridge.request("/api/device/tasks");

  assert.deepEqual(value, { task: null });
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].options.headers["x-team-room-device-secret"], "device-secret");
});
