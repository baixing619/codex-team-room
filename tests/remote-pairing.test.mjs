import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeUtf8Base64, encodeUtf8Base64, RemotePairingBridge, sanitizeRuntimeEvent, windowsNativeRequest } from "../server/remotePairingBridge.mjs";

test("Windows fallback transport preserves Chinese project names and paths", () => {
  const value = JSON.stringify({ name: "白星动画", path: "G:\\动画项目\\白星" });
  assert.equal(decodeUtf8Base64(encodeUtf8Base64(value)), value);
});

test("Windows-native HTTP fallback sends and receives Chinese JSON without question marks", { skip: process.platform !== "win32" }, async () => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ...received, title: "白星动画讨论" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await windowsNativeRequest(`http://127.0.0.1:${address.port}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "白星动画", path: "G:\\动画项目\\白星" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: "白星动画", path: "G:\\动画项目\\白星", title: "白星动画讨论" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Windows-native HTTP fallback terminates its child when the request times out", { skip: process.platform !== "win32" }, async () => {
  const sockets = new Set();
  const server = createServer(() => {
    // Keep the response open: the fallback itself must enforce the deadline.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const startedAt = Date.now();
    await assert.rejects(
      windowsNativeRequest(`http://127.0.0.1:${address.port}/never-finishes`, { timeoutMs: 50 }),
      { message: "remote_request_timeout" },
    );
    assert.ok(Date.now() - startedAt < 750);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
  assert.equal(sanitized.roomId, null);
  assert.equal(sanitized.taskId, null);
  assert.deepEqual(sanitized.item, { type: "commandExecution", status: "completed" });
});

test("sanitized runtime events retain room and task routing without retaining local paths", () => {
  const sanitized = sanitizeRuntimeEvent({
    sequence: 10,
    type: "agentMessage",
    createdAt: "2026-08-01T00:00:00.000Z",
    roomId: "room-animation",
    taskId: "task-1",
    cwd: "G:\\private-project",
    agentId: "developer",
    threadId: "thread-1",
    turnId: "turn-1",
    text: "已完成",
  });

  assert.equal(sanitized.roomId, "room-animation");
  assert.equal(sanitized.taskId, "task-1");
  assert.equal(sanitized.cwd, undefined);
});

test("sanitized agent thread bindings retain their binding mode", () => {
  const sanitized = sanitizeRuntimeEvent({
    sequence: 11,
    type: "agentThreadBound",
    createdAt: "2026-08-01T00:00:00.000Z",
    roomId: "room-animation",
    taskId: "task-1",
    agentId: "developer",
    threadId: "thread-current-project",
    model: "gpt-5.6",
    bindingMode: "existing",
    cwd: "G:\\private-project",
  });

  assert.equal(sanitized.bindingMode, "existing");
  assert.equal(sanitized.cwd, undefined);
});

test("turn-start receipts retain only the context cursor needed for cross-browser delta delivery", () => {
  const sanitized = sanitizeRuntimeEvent({
    sequence: 12,
    type: "turnStarted",
    roomId: "room-animation",
    taskId: "task-2",
    agentId: "developer",
    threadId: "thread-developer",
    turnId: "turn-2",
    contextCursorUpdate: {
      agentId: "developer",
      threadId: "thread-developer",
      deliverySequence: 3,
      messageFingerprints: { "message-1": "fnv1a:1234" },
      knowledgeFingerprints: { "knowledge-1": "fnv1a:5678" },
      lastContextId: "context-2",
      privateText: "must-not-pass",
    },
  });

  assert.deepEqual(sanitized.contextCursorUpdate, {
    version: 1,
    initialized: true,
    agentId: "developer",
    threadId: "thread-developer",
    deliverySequence: 3,
    messageFingerprints: { "message-1": "fnv1a:1234" },
    knowledgeFingerprints: { "knowledge-1": "fnv1a:5678" },
    lastContextId: "context-2",
  });
});

test("coordinator decision lock is preserved for the private room without leaking extra data", () => {
  const sanitized = sanitizeRuntimeEvent({
    sequence: 13,
    type: "coordinatorDecisionLocked",
    roomId: "room-animation",
    taskId: "task-decision",
    turnId: "turn-summary",
    status: "locked",
    privateText: "must-not-pass",
  });

  assert.deepEqual(sanitized, {
    sequence: 13,
    createdAt: undefined,
    roomId: "room-animation",
    taskId: "task-decision",
    agentId: null,
    turnId: "turn-summary",
    status: "locked",
    public: true,
  });
});

test("approval events sent to the private site sanitize command, reason, and failure details", () => {
  const requested = sanitizeRuntimeEvent({
    type: "approvalRequested",
    requestId: 7,
    approvalKey: "approval-7",
    method: "item/commandExecution/requestApproval",
    command: "Get-Content G:\\private\\secret.txt sk-live-secret",
    reason: "PS G:\\private\\project> output with token ghp_example-secret",
    error: "G:\\private\\error.log",
    threadId: "thread-7",
    turnId: "turn-7",
  });
  assert.match(requested.command, /本机路径已隐藏/);
  assert.doesNotMatch(requested.command, /sk-live-secret/);
  assert.match(requested.reason, /命令输出已隐藏/);
  assert.doesNotMatch(requested.reason, /ghp_example-secret/);
  assert.match(requested.error, /本机路径已隐藏/);
  assert.equal(requested.cwd, undefined);
  const failed = sanitizeRuntimeEvent({ type: "approvalFailed", requestId: 7, error: "G:\\private\\failure.txt sk-live-secret" });
  assert.match(failed.error, /本机路径已隐藏/);
  assert.doesNotMatch(failed.error, /sk-live-secret/);
  const taskFailed = sanitizeRuntimeEvent({ type: "taskFailed", error: "G:\\private\\task.txt sk_live_secret" });
  assert.match(taskFailed.error, /本机路径已隐藏/);
  assert.doesNotMatch(taskFailed.error, /sk_live_secret/);
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
    listEvents() { return [{ sequence: 1, type: "agentMessage", roomId: "room-two", taskId: "task-1", agentId: "coordinator", text: "已完成" }]; },
  };
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, options });
    if (pathname === "/api/device/tasks") return Response.json({ task: { id: "task-1", room_id: "room-two", cwd: "G:\\project-two", text: "开始", message_id: "message-1", decisions: [{ agentId: "coordinator", decision: "speak" }], agents: [{ id: "coordinator" }] } });
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
  assert.equal(runtime.connectCalls[0].roomId, "room-two");
  assert.equal(runtime.connectCalls[0].taskId, "task-1");
  assert.equal(runtime.dispatchCalls[0].text, "开始");
  assert.equal(runtime.dispatchCalls[0].roomId, "room-two");
  assert.equal(runtime.dispatchCalls[0].taskId, "task-1");
  assert.deepEqual(runtime.approvalCalls, [{ requestId: 42, decision: "accept" }]);
  assert.ok(calls.some((call) => call.pathname === "/api/device/events"));
  const eventUpload = calls.find((call) => call.pathname === "/api/device/events");
  assert.deepEqual(JSON.parse(eventUpload.options.body).events, [{
    taskId: "task-1",
    type: "agentMessage",
    payload: { sequence: 1, roomId: "room-two", taskId: "task-1", agentId: "coordinator", text: "已完成" },
  }]);
  assert.ok(calls.every((call) => call.options.headers["x-team-room-device-secret"] === "device-secret"));
  assert.ok(calls.every((call) => call.options.headers["OAI-Sites-Authorization"] === "Bearer bypass-token"));
  assert.equal(bridge.lastError, null);
});

test("paired bridge reads project metadata only when the private site requests it", async () => {
  let uploadedResult = null;
  let indexClaims = 0;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/device/tasks") return Response.json({ task: null });
    if (pathname === "/api/device/approvals") return Response.json({ approval: null });
    if (pathname === "/api/device/index-requests") {
      indexClaims += 1;
      if (indexClaims > 1) return Response.json({ indexRequest: null });
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
  assert.equal(indexClaims, 2);
});

test("paired bridge refuses existing thread bindings that are not part of the requested project", async () => {
  const results = [];
  const runtime = {
    connectCalls: [],
    async connect(value) { this.connectCalls.push(value); },
    async dispatch() {},
  };
  const bridge = new RemotePairingBridge({
    runtime,
    fetchImpl: async (url, options = {}) => {
      if (new URL(url).pathname.endsWith("/result")) results.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    indexProvider: {
      listProjects: () => [{ path: "G:\\project-two", exists: true }],
      listThreads: (cwd) => {
        assert.equal(cwd, "G:\\project-two");
        return [{ id: "thread-current-project" }];
      },
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };

  await assert.rejects(bridge.processTask({
    id: "task-cross-project-thread",
    cwd: "G:\\project-two",
    text: "开始",
    message_id: "message-1",
    decisions: [{ agentId: "developer", decision: "speak" }],
    agents: [{ id: "developer", threadBinding: "existing", boundThreadId: "thread-other-project" }],
  }), { message: "remote_thread_binding_not_found" });

  assert.deepEqual(runtime.connectCalls, []);
  assert.deepEqual(results, [{ status: "failed", error: "remote_thread_binding_not_found", deviceId: "device-1" }]);
});

test("remote attachment downloads pass absolute local paths and shared context once across idempotent repeat processing", async () => {
  const taskId = `task-attachment-repeat-${process.pid}`;
  const attachmentDirectory = path.join(os.tmpdir(), "codex-team-room-attachments", taskId);
  fs.rmSync(attachmentDirectory, { recursive: true, force: true });
  const runtime = {
    connectCalls: [],
    dispatchCalls: [],
    async connect(value) { this.connectCalls.push(value); },
    async dispatch(value) { this.dispatchCalls.push(value); },
    async waitForTask() { return { status: "succeeded", error: null }; },
  };
  const taskResults = [];
  let downloadCount = 0;
  const sharedContext = { id: "shared-remote-attachment", roomName: "远程附件", recentMessages: [{ role: "user", text: "请读取附件" }] };
  const bridge = new RemotePairingBridge({
    runtime,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/api/device/attachments/attachment-1") {
        downloadCount += 1;
        return Response.json({ name: "资料.txt", type: "text/plain", dataBase64: Buffer.from("远程附件内容").toString("base64") });
      }
      if (pathname.endsWith(`/api/device/tasks/${taskId}/result`)) {
        taskResults.push(JSON.parse(options.body));
        return Response.json({ ok: true });
      }
      if (pathname.endsWith(`/api/device/tasks/${taskId}/status`)) return Response.json({ ok: true });
      throw new Error(`unexpected_request:${pathname}`);
    },
    indexProvider: { listProjects: () => [{ path: "G:\\project-two", exists: true }] },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };
  const task = {
    id: taskId,
    room_id: "room-two",
    cwd: "G:\\project-two",
    text: "处理远程附件",
    message_id: "message-attachment",
    decisions: [{ agentId: "coordinator", decision: "speak" }],
    agents: [{ id: "coordinator" }],
    attachments: [{ id: "attachment-1", name: "资料.txt", type: "text/plain" }],
    sharedContext,
  };

  try {
    await bridge.processTask(task);
    await bridge.processTask(task);

    assert.equal(runtime.dispatchCalls.length, 1);
    assert.deepEqual(runtime.dispatchCalls[0].sharedContext, sharedContext);
    assert.equal(runtime.dispatchCalls[0].attachments.length, 1);
    const [attachment] = runtime.dispatchCalls[0].attachments;
    assert.equal(path.isAbsolute(attachment.path), true);
    assert.equal(fs.readFileSync(attachment.path, "utf8"), "远程附件内容");
    assert.equal(downloadCount, 1);
    assert.deepEqual(taskResults, [{ status: "succeeded", error: null, deviceId: "device-1" }]);
  } finally {
    fs.rmSync(attachmentDirectory, { recursive: true, force: true });
  }
});

test("Windows-native request fallback handles a Cloudflare block without exposing a second API", async () => {
  const nativeCalls = [];
  let fetchCalls = 0;
  const bridge = new RemotePairingBridge({
    runtime: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    },
    nativeRequestImpl: async (url, options) => {
      nativeCalls.push({ url, options });
      return Response.json({ task: null });
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token" };

  const value = await bridge.request("/api/device/tasks");
  await bridge.request("/api/device/tasks");

  assert.deepEqual(value, { task: null });
  assert.equal(fetchCalls, 1);
  assert.equal(nativeCalls.length, 2);
  assert.equal(nativeCalls[0].options.headers["x-team-room-device-secret"], "device-secret");
});

test("remote bridge retries one transient native 599 response", async () => {
  let nativeCalls = 0;
  const bridge = new RemotePairingBridge({
    runtime: {},
    fetchImpl: async () => new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }),
    nativeRequestImpl: async () => {
      nativeCalls += 1;
      if (nativeCalls === 1) return new Response("temporary transport failure", { status: 599 });
      return Response.json({ task: null, title: "延续Pro订阅回本策略" });
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token" };

  const value = await bridge.request("/api/device/tasks");

  assert.equal(nativeCalls, 2);
  assert.deepEqual(value, { task: null, title: "延续Pro订阅回本策略" });
});

test("remote bridge releases its polling lock when an outbound request times out", async () => {
  const bridge = new RemotePairingBridge({
    runtime: { listEvents: () => [] },
    fetchImpl: async () => new Promise(() => {}),
    requestTimeoutMs: 10,
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };

  await bridge.tick();

  assert.equal(bridge.busy, false);
  assert.equal(bridge.lastError, "remote_request_timeout");
});

test("remote bridge also times out while a response body never finishes", async () => {
  const bridge = new RemotePairingBridge({
    runtime: {},
    fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }),
    requestTimeoutMs: 10,
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token" };

  await assert.rejects(bridge.request("/api/device/tasks"), { message: "remote_request_timeout" });
});

test("remote bridge reports running before the runtime terminal result and sanitizes failures", async () => {
  let resolveTask;
  const calls = [];
  const runtime = {
    async connect() {},
    async dispatch() {},
    waitForTask() { return new Promise((resolve) => { resolveTask = resolve; }); },
  };
  const bridge = new RemotePairingBridge({
    runtime,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/status") || pathname.endsWith("/result")) calls.push({ pathname, body: JSON.parse(options.body) });
      return Response.json({ ok: true });
    },
    indexProvider: { listProjects: () => [{ path: "G:\\project", exists: true }] },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };
  const taskPromise = bridge.processTask({ id: "task-terminal-failure", room_id: "room-1", cwd: "G:\\project", text: "执行", message_id: "message-terminal-failure", decisions: [{ agentId: "coordinator", decision: "speak" }], agents: [{ id: "coordinator" }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ pathname: "/api/device/tasks/task-terminal-failure/status", body: { status: "running", error: null, deviceId: "device-1" } }]);
  resolveTask({ status: "failed", error: "G:\\private\\secret.txt" });
  const result = await taskPromise;
  assert.equal(result.status, "failed");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.status, "failed");
  assert.match(calls[1].body.error, /本机路径已隐藏/);
});

test("remote approval failures are emitted and uploaded on the same tick", async () => {
  const calls = [];
  const events = [];
  const runtime = {
    resolveApproval() { throw new Error("G:\\private\\approval.txt sk-live-secret"); },
    listEvents(after = 0) { return events.filter((event) => event.sequence > after); },
    emitRoomEvent(type, payload) {
      const event = { sequence: events.length + 1, type, createdAt: "2026-08-02T00:00:00.000Z", ...payload };
      events.push(event);
      return event;
    },
  };
  const bridge = new RemotePairingBridge({
    runtime,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, options });
      if (pathname === "/api/device/tasks") return Response.json({ task: null });
      if (pathname === "/api/device/approvals") return Response.json({ approval: { id: "approval-1", request_id: "41", approval_key: "approval:key", decision: "accept" } });
      if (pathname === "/api/device/index-requests") return Response.json({ error: "not_found" }, { status: 404 });
      if (pathname.endsWith("/result")) return new Response("temporary result outage", { status: 503 });
      return Response.json({ ok: true });
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };

  await bridge.tick();

  const upload = calls.find((call) => call.pathname === "/api/device/events");
  assert.ok(upload);
  const uploadedEvents = JSON.parse(upload.options.body).events;
  const uploadedFailure = uploadedEvents.find((item) => item.type === "approvalFailed" && item.payload.requestId === 41);
  assert.ok(uploadedFailure);
  assert.match(uploadedFailure.payload.error, /本机路径已隐藏/);
  assert.doesNotMatch(uploadedFailure.payload.error, /sk-live-secret|G:\\private/);
  assert.match(bridge.lastError, /本机路径已隐藏/);
  assert.equal(bridge.busy, false);
});

test("a failed result acknowledgement after local approval never emits a false approval failure", async () => {
  const calls = [];
  const events = [];
  const runtime = {
    resolveApproval({ requestId, decision }) {
      this.emitRoomEvent("approvalResolved", { requestId, approvalKey: "approval:accepted", decision, roomId: "room-1", taskId: "task-1", agentId: "developer", threadId: "thread-1", turnId: "turn-1" });
    },
    listEvents(after = 0) { return events.filter((event) => event.sequence > after); },
    emitRoomEvent(type, payload) {
      const event = { sequence: events.length + 1, type, createdAt: "2026-08-02T00:00:00.000Z", ...payload };
      events.push(event);
      return event;
    },
  };
  const bridge = new RemotePairingBridge({
    runtime,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, options });
      if (pathname === "/api/device/tasks") return Response.json({ task: null });
      if (pathname === "/api/device/approvals") return Response.json({ approval: { id: "approval-accepted", request_id: "51", approval_key: "approval:accepted", routeJson: { roomId: "room-1", taskId: "task-1", agentId: "developer", threadId: "thread-1", turnId: "turn-1" }, decision: "accept" } });
      if (pathname === "/api/device/index-requests") return Response.json({ error: "not_found" }, { status: 404 });
      if (pathname === "/api/device/approvals/approval-accepted/result") return Response.json({ error: "temporary_result_outage" }, { status: 503 });
      return Response.json({ ok: true });
    },
  });
  bridge.config = { siteUrl: "https://private.example", deviceSecret: "device-secret", siwcBypassToken: "bypass-token", cwd: "G:\\project", deviceId: "device-1", deviceLabel: "工作电脑" };
  bridge.lastHeartbeatAt = Date.now();

  await bridge.tick();

  assert.equal(events.some((event) => event.type === "approvalFailed"), false);
  assert.equal(events.some((event) => event.type === "approvalResolved" && event.requestId === 51), true);
  const uploaded = calls.find((call) => call.pathname === "/api/device/events");
  assert.ok(uploaded);
  const uploadedEvents = JSON.parse(uploaded.options.body).events;
  assert.equal(uploadedEvents.some((event) => event.type === "approvalResolved"), true);
  assert.equal(uploadedEvents.some((event) => event.type === "approvalFailed"), false);
  const resultBodies = calls
    .filter((call) => call.pathname === "/api/device/approvals/approval-accepted/result")
    .map((call) => JSON.parse(call.options.body));
  assert.equal(resultBodies.every((body) => body.ok === true), true);
});
