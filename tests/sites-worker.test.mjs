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

test("keeps every source input required by Sites packaging", async () => {
  await access(new URL("../index.html", import.meta.url));
  await access(new URL("../worker/index.js", import.meta.url));
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(new URL("../drizzle", import.meta.url));
});
