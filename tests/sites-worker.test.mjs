import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

function createIndexRequestDb() {
  const rows = new Map();
  return {
    batch: async () => [],
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async run() {
          if (sql.startsWith("INSERT INTO remote_index_requests")) {
            const [id, user_id, request_type, request_json] = values;
            rows.set(id, { id, user_id, request_type, request_json, status: "pending", result_json: null, error: null, created_at: "2026-08-01 00:00:00", completed_at: null });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE remote_index_requests SET status = 'claimed'")) {
            const row = rows.get(values[0]);
            if (!row || row.status !== "pending") return { meta: { changes: 0 } };
            row.status = "claimed";
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE remote_index_requests SET status = ?")) {
            const [status, result_json, error, id] = values;
            const row = rows.get(id);
            if (row?.status === "claimed") Object.assign(row, { status, result_json, error, completed_at: "2026-08-01 00:00:01" });
            return { meta: { changes: row ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("status IN ('pending', 'claimed')")) {
            const [userId, requestType, requestJson] = values;
            return Array.from(rows.values()).find((row) => row.user_id === userId && row.request_type === requestType && row.request_json === requestJson && ["pending", "claimed"].includes(row.status)) || null;
          }
          if (sql.includes("status = 'completed'")) {
            const [userId, requestType, requestJson] = values;
            return Array.from(rows.values()).find((row) => row.user_id === userId && row.request_type === requestType && row.request_json === requestJson && row.status === "completed") || null;
          }
          if (sql.includes("FROM remote_index_requests WHERE status = 'pending'")) {
            return Array.from(rows.values()).find((row) => row.status === "pending") || null;
          }
          if (sql.includes("FROM remote_index_requests WHERE id = ? AND user_id = ?")) {
            const row = rows.get(values[0]);
            return row?.user_id === values[1] ? row : null;
          }
          return null;
        },
      };
    },
  };
}

function createAttachmentTaskEnv() {
  const objects = new Map();
  const tasks = new Map();
  const deletedObjects = [];
  const attachments = {
    async put(key, value, options) {
      objects.set(key, {
        bytes: new Uint8Array(value),
        customMetadata: { ...options.customMetadata },
      });
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, customMetadata: { ...object.customMetadata } } : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        customMetadata: { ...object.customMetadata },
        arrayBuffer: async () => object.bytes.slice().buffer,
      };
    },
    async delete(key) {
      deletedObjects.push(key);
      objects.delete(key);
    },
  };
  const db = {
    batch: async () => [],
    prepare(sql) {
      let values = [];
      return {
        bind(...next) { values = next; return this; },
        async run() {
          if (sql.startsWith("INSERT INTO remote_tasks")) {
            const [id, user_id, room_id, message_id, cwd, text, decisions_json, agents_json, attachments_json, shared_context_json] = values;
            tasks.set(id, { id, user_id, room_id, message_id, cwd, text, decisions_json, agents_json, attachments_json, shared_context_json, status: "pending", created_at: "2026-08-01 00:00:00" });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE remote_tasks SET status = 'claimed'")) {
            const task = tasks.get(values[0]);
            if (!task || task.status !== "pending") return { meta: { changes: 0 } };
            task.status = "claimed";
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE remote_tasks SET status = ?")) {
            const [status, error, id] = values;
            const task = tasks.get(id);
            if (task?.status === "claimed") Object.assign(task, { status, error });
            return { meta: { changes: task ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("FROM remote_tasks WHERE status = 'pending'")) {
            return Array.from(tasks.values()).find((task) => task.status === "pending") || null;
          }
          if (sql.startsWith("SELECT attachments_json FROM remote_tasks WHERE id = ?")) {
            const task = tasks.get(values[0]);
            return task ? { attachments_json: task.attachments_json } : null;
          }
          return null;
        },
      };
    },
  };
  return {
    env: { DB: db, ATTACHMENTS: attachments, TEAM_ROOM_DEVICE_SECRET: "device-secret" },
    objects,
    tasks,
    deletedObjects,
  };
}

function createOwnerStateEnv() {
  let row = null;
  return {
    TEAM_ROOM_DEVICE_SECRET: "device-secret",
    DB: {
      batch: async () => [],
      prepare(sql) {
        let values = [];
        return {
          bind(...next) { values = next; return this; },
          async run() {
            if (sql.startsWith("INSERT INTO owner_state")) {
              if (row) throw new Error("unique_constraint");
              const [user_id, revision, state_json] = values;
              row = { user_id, revision, state_json, updated_at: "2026-08-01 00:00:00" };
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("UPDATE owner_state SET revision")) {
              const [revision, state_json, user_id, expectedRevision] = values;
              if (!row || row.user_id !== user_id || row.revision !== expectedRevision) return { meta: { changes: 0 } };
              row = { ...row, revision, state_json, updated_at: "2026-08-01 00:00:01" };
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async first() {
            if (sql.startsWith("SELECT revision, state_json, updated_at FROM owner_state")) return row ? { ...row } : null;
            return null;
          },
        };
      },
    },
  };
}

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("keeps owner writes same-origin and requires device authentication", async () => {
  const ownerResponse = await worker.fetch(new Request("https://example.test/api/remote/tasks", {
    method: "POST",
    headers: { origin: "https://malicious.example" },
  }), {});
  assert.equal(ownerResponse.status, 403);
  assert.equal((await ownerResponse.json()).error, "same_origin_required");

  const deviceResponse = await worker.fetch(new Request("https://example.test/api/device/tasks"), {
    TEAM_ROOM_DEVICE_SECRET: "example-device-secret",
  });
  assert.equal(deviceResponse.status, 401);
  assert.equal((await deviceResponse.json()).error, "device_auth_required");
});

test("reports a recently seen paired device to the authenticated owner", async () => {
  const device = { id: "device-test", label: "工作电脑", version: "0.2.0", last_seen_at: new Date().toISOString().slice(0, 19).replace("T", " ") };
  const response = await worker.fetch(new Request("https://example.test/api/pair/status"), {
    DB: {
      batch: async () => [],
      prepare() {
        return { first: async () => device };
      },
    },
  });

  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.paired, true);
  assert.equal(status.online, true);
  assert.equal(status.device.label, "工作电脑");
});

test("relays an owner index request through the authenticated paired device", async () => {
  const env = { DB: createIndexRequestDb(), TEAM_ROOM_DEVICE_SECRET: "device-secret" };
  const created = await worker.fetch(new Request("https://example.test/api/remote/index-requests", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ type: "projects" }),
  }), env);
  assert.equal(created.status, 201);
  const requestId = (await created.json()).indexRequest.id;

  const claimed = await worker.fetch(new Request("https://example.test/api/device/index-requests", {
    headers: { "x-team-room-device-secret": "device-secret" },
  }), env);
  const claimedBody = await claimed.json();
  assert.equal(claimedBody.indexRequest.id, requestId);
  assert.equal(claimedBody.indexRequest.request_type, "projects");

  const completed = await worker.fetch(new Request(`https://example.test/api/device/index-requests/${requestId}/result`, {
    method: "POST",
    headers: { "x-team-room-device-secret": "device-secret", "content-type": "application/json" },
    body: JSON.stringify({ ok: true, result: { projects: [{ name: "现有项目", path: "G:\\project", threadCount: 2 }] } }),
  }), env);
  assert.equal(completed.status, 200);

  const status = await worker.fetch(new Request(`https://example.test/api/remote/index-requests/${requestId}`), env);
  const statusBody = await status.json();
  assert.equal(statusBody.indexRequest.status, "completed");
  assert.equal(statusBody.indexRequest.result.projects[0].name, "现有项目");
});

test("reuses an in-flight index request and serves a recent completed result without rereading the computer", async () => {
  const env = { DB: createIndexRequestDb(), TEAM_ROOM_DEVICE_SECRET: "device-secret" };
  const create = () => worker.fetch(new Request("https://example.test/api/remote/index-requests", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ type: "threads", projectPath: "G:\\project" }),
  }), env);

  const first = await create();
  const firstBody = await first.json();
  const duplicate = await create();
  const duplicateBody = await duplicate.json();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.reused, true);
  assert.equal(duplicateBody.indexRequest.id, firstBody.indexRequest.id);

  await worker.fetch(new Request("https://example.test/api/device/index-requests", { headers: { "x-team-room-device-secret": "device-secret" } }), env);
  await worker.fetch(new Request(`https://example.test/api/device/index-requests/${firstBody.indexRequest.id}/result`, {
    method: "POST",
    headers: { "x-team-room-device-secret": "device-secret", "content-type": "application/json" },
    body: JSON.stringify({ ok: true, result: { threads: [{ id: "thread-1", title: "已缓存" }] } }),
  }), env);

  const cached = await create();
  const cachedBody = await cached.json();
  assert.equal(cached.status, 200);
  assert.equal(cachedBody.cached, true);
  assert.equal(cachedBody.indexRequest.result.threads[0].title, "已缓存");
});

test("reclaims an expired device index claim so a retry is not stuck forever", async () => {
  const statements = [];
  const env = {
    TEAM_ROOM_DEVICE_SECRET: "device-secret",
    DB: {
      batch: async () => [],
      prepare(sql) {
        let values = [];
        return {
          bind(...next) { values = next; return this; },
          async run() {
            statements.push({ sql, values });
            if (sql.startsWith("UPDATE remote_index_requests SET status = 'claimed'")) return { meta: { changes: 1 } };
            return { meta: { changes: 0 } };
          },
          async first() {
            if (sql.includes("FROM remote_index_requests WHERE status = 'pending'")) {
              return { id: "expired-index-1", request_type: "messages", request_json: JSON.stringify({ threadId: "thread-1" }), created_at: "2026-08-01 00:00:00" };
            }
            return null;
          },
        };
      },
    },
  };

  const response = await worker.fetch(new Request("https://example.test/api/device/index-requests", {
    headers: { "x-team-room-device-secret": "device-secret" },
  }), env);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).indexRequest.id, "expired-index-1");
  assert.ok(statements.some(({ sql }) => sql.includes("device_request_lease_expired")));
});

test("reclaims expired task and approval claims before returning them to the device", async () => {
  for (const scenario of [
    { table: "remote_tasks", pathname: "/api/device/tasks", property: "task", row: { id: "expired-task-1", room_id: "room-1", message_id: "message-1", cwd: "G:\\project", text: "继续", decisions_json: "[]", agents_json: "[]", created_at: "2026-08-01 00:00:00" } },
    { table: "remote_approvals", pathname: "/api/device/approvals", property: "approval", row: { id: "expired-approval-1", request_id: "42", decision: "accept", created_at: "2026-08-01 00:00:00" } },
  ]) {
    const statements = [];
    const env = {
      TEAM_ROOM_DEVICE_SECRET: "device-secret",
      DB: {
        batch: async () => [],
        prepare(sql) {
          let values = [];
          return {
            bind(...next) { values = next; return this; },
            async run() {
              statements.push({ sql, values });
              if (sql.startsWith(`UPDATE ${scenario.table} SET status = 'claimed'`)) return { meta: { changes: 1 } };
              return { meta: { changes: 0 } };
            },
            async first() {
              if (sql.includes(`FROM ${scenario.table} WHERE status = 'pending'`)) return scenario.row;
              return null;
            },
          };
        },
      },
    };

    const response = await worker.fetch(new Request(`https://example.test${scenario.pathname}`, {
      headers: { "x-team-room-device-secret": "device-secret" },
    }), env);

    assert.equal(response.status, 200);
    assert.equal((await response.json())[scenario.property].id, scenario.row.id);
    assert.ok(statements.some(({ sql }) => sql.startsWith(`UPDATE ${scenario.table} SET status = 'pending'`)));
  }
});

test("owner and paired device share cloud state with revision CAS conflict protection", async () => {
  const env = createOwnerStateEnv();
  const ownerHeaders = { origin: "https://example.test", "content-type": "application/json" };
  const deviceHeaders = { "x-team-room-device-secret": "device-secret", "content-type": "application/json" };

  const empty = await worker.fetch(new Request("https://example.test/api/state", { headers: ownerHeaders }), env);
  assert.deepEqual(await empty.json(), { state: null, revision: 0, updatedAt: null });

  const phoneState = { rooms: [{ id: "phone-room", name: "手机项目" }], messagesByRoom: { "phone-room": [{ id: "phone-message", text: "手机同步消息" }] } };
  const created = await worker.fetch(new Request("https://example.test/api/state", {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ state: phoneState, baseRevision: 0 }),
  }), env);
  assert.equal(created.status, 200);
  assert.equal((await created.json()).revision, 1);

  const deviceRead = await worker.fetch(new Request("https://example.test/api/device/state", { headers: deviceHeaders }), env);
  const deviceState = await deviceRead.json();
  assert.deepEqual(deviceState.state, phoneState);
  assert.equal(deviceState.revision, 1);

  const computerState = { rooms: [{ id: "desktop-room", name: "电脑项目" }] };
  const updated = await worker.fetch(new Request("https://example.test/api/state", {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ state: computerState, baseRevision: 1 }),
  }), env);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).revision, 2);

  const stale = await worker.fetch(new Request("https://example.test/api/state", {
    method: "PUT",
    headers: ownerHeaders,
    body: JSON.stringify({ state: { rooms: [{ id: "stale-room" }] }, baseRevision: 1 }),
  }), env);
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: "sync_conflict",
    state: computerState,
    revision: 2,
    updatedAt: "2026-08-01 00:00:01",
  });

  const ownerRead = await worker.fetch(new Request("https://example.test/api/state", { headers: ownerHeaders }), env);
  assert.deepEqual(await ownerRead.json(), { state: computerState, revision: 2, updatedAt: "2026-08-01 00:00:01" });
});

test("stores uploaded R2 attachments and shared context with a task, serves them to the device, then deletes objects on completion", async () => {
  const { env, objects, tasks, deletedObjects } = createAttachmentTaskEnv();
  const upload = await worker.fetch(new Request("https://example.test/api/attachments", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      "content-type": "text/plain",
      "x-file-name": encodeURIComponent("计划.txt"),
    },
    body: "附件内容",
  }), env);
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachment;

  const sharedContext = { id: "shared-attachment-context", roomName: "附件协作", recentMessages: [{ role: "user", text: "请读取附件" }] };
  const created = await worker.fetch(new Request("https://example.test/api/remote/tasks", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      roomId: "room-attachment",
      messageId: "message-attachment",
      cwd: "G:\\attachment-project",
      text: "请处理附件",
      decisions: [{ agentId: "coordinator", decision: "speak" }],
      agents: [{ id: "coordinator" }],
      attachments: [{ id: attachment.id, name: "不可信名称.txt" }],
      sharedContext,
    }),
  }), env);
  assert.equal(created.status, 201);
  const taskId = (await created.json()).task.id;
  const storedTask = tasks.get(taskId);
  assert.deepEqual(JSON.parse(storedTask.attachments_json), [{ id: attachment.id, name: "计划.txt", type: "text/plain", size: 12 }]);
  assert.deepEqual(JSON.parse(storedTask.shared_context_json), sharedContext);

  const claimed = await worker.fetch(new Request("https://example.test/api/device/tasks", {
    headers: { "x-team-room-device-secret": "device-secret" },
  }), env);
  const deviceTask = (await claimed.json()).task;
  assert.deepEqual(deviceTask.attachments, [{ id: attachment.id, name: "计划.txt", type: "text/plain", size: 12 }]);
  assert.deepEqual(deviceTask.sharedContext, sharedContext);

  const downloaded = await worker.fetch(new Request(`https://example.test/api/device/attachments/${attachment.id}`, {
    headers: { "x-team-room-device-secret": "device-secret" },
  }), env);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from((await downloaded.json()).dataBase64, "base64").toString("utf8"), "附件内容");

  const completed = await worker.fetch(new Request(`https://example.test/api/device/tasks/${taskId}/result`, {
    method: "POST",
    headers: { "x-team-room-device-secret": "device-secret", "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  }), env);
  assert.equal(completed.status, 200);
  assert.equal(objects.has(`site-owner/${attachment.id}`), false);
  assert.deepEqual(deletedObjects, [`site-owner/${attachment.id}`]);
  assert.equal(tasks.get(taskId).status, "completed");
});

test("keeps every source input required by Sites packaging", async () => {
  await access(new URL("../index.html", import.meta.url));
  await access(new URL("../worker/index.js", import.meta.url));
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(new URL("../drizzle", import.meta.url));
});
