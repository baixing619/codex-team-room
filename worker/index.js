const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_BODY_BYTES = 256 * 1024;
const ONLINE_WINDOW_MS = 30_000;
const ALLOWED_APPROVAL_DECISIONS = new Set(["accept", "decline"]);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new Error("request_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("request_too_large");
  return text ? JSON.parse(text) : {};
}

async function equalSecret(actual, expected) {
  if (!actual || !expected) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let different = a.length ^ b.length;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) different |= a[index] ^ b[index];
  return different === 0;
}

function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function authenticatedOwner(request) {
  return Boolean(request.headers.get("oai-authenticated-user-id"));
}

async function authenticatedDevice(request, env) {
  return equalSecret(request.headers.get("x-team-room-device-secret"), env.TEAM_ROOM_DEVICE_SECRET);
}

function parseRow(row) {
  if (!row) return null;
  const result = { ...row };
  for (const key of ["decisions_json", "agents_json", "payload_json"]) {
    if (!(key in result)) continue;
    const nextKey = key.replace(/_json$/, "").replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    try {
      result[nextKey] = JSON.parse(result[key]);
    } catch {
      result[nextKey] = key === "payload_json" ? {} : [];
    }
    delete result[key];
  }
  return result;
}

async function ensureDatabase(env) {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  if (env.__teamRoomSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS paired_devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, version TEXT, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL, decisions_json TEXT NOT NULL, agents_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_at TEXT, completed_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL, task_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_approvals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_at TEXT, completed_at TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_tasks_status_created ON remote_tasks(status, created_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_events_user_sequence ON remote_events(user_id, sequence)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_approvals_status_created ON remote_approvals(status, created_at)"),
  ]);
  env.__teamRoomSchemaReady = true;
}

async function handleOwnerApi(request, env, url) {
  if (!authenticatedOwner(request)) return json({ error: "owner_auth_required" }, 401);
  if (!isSameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  await ensureDatabase(env);
  const userId = request.headers.get("oai-authenticated-user-id");

  if (request.method === "GET" && url.pathname === "/api/pair/status") {
    const device = await env.DB.prepare("SELECT id, label, version, last_seen_at FROM paired_devices ORDER BY last_seen_at DESC LIMIT 1").first();
    const lastSeenAt = device?.last_seen_at || null;
    const online = Boolean(lastSeenAt && Date.now() - new Date(`${lastSeenAt}Z`).getTime() <= ONLINE_WINDOW_MS);
    return json({ paired: Boolean(device), online, device: device ? { id: device.id, label: device.label, version: device.version, lastSeenAt } : null });
  }

  if (request.method === "POST" && url.pathname === "/api/remote/tasks") {
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const decisions = Array.isArray(body.decisions) ? body.decisions.slice(0, 12) : [];
    const agents = Array.isArray(body.agents) ? body.agents.slice(0, 12) : [];
    if (!text || text.length > 20_000) return json({ error: "invalid_task_text" }, 400);
    if (!decisions.length || !agents.length) return json({ error: "task_members_required" }, 400);
    const id = crypto.randomUUID();
    const messageId = typeof body.messageId === "string" && body.messageId ? body.messageId.slice(0, 160) : crypto.randomUUID();
    const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId.slice(0, 160) : "default";
    await env.DB.prepare("INSERT INTO remote_tasks (id, user_id, room_id, message_id, text, decisions_json, agents_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, roomId, messageId, text, JSON.stringify(decisions), JSON.stringify(agents)).run();
    return json({ task: { id, status: "pending", messageId } }, 201);
  }

  if (request.method === "GET" && url.pathname === "/api/remote/events") {
    const after = Math.max(0, Number(url.searchParams.get("after") || 0) || 0);
    const result = await env.DB.prepare("SELECT sequence, task_id, event_type, payload_json, created_at FROM remote_events WHERE user_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 200")
      .bind(userId, after).all();
    return json({ events: (result.results || []).map(parseRow) });
  }

  if (request.method === "POST" && url.pathname === "/api/remote/approvals") {
    const body = await readJson(request);
    const requestId = String(body.requestId ?? "").slice(0, 160);
    const decision = String(body.decision || "");
    if (!requestId || !ALLOWED_APPROVAL_DECISIONS.has(decision)) return json({ error: "invalid_approval" }, 400);
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO remote_approvals (id, user_id, request_id, decision) VALUES (?, ?, ?, ?)")
      .bind(id, userId, requestId, decision).run();
    return json({ approval: { id, requestId, decision, status: "pending" } }, 201);
  }

  return json({ error: "not_found" }, 404);
}

async function claimNext(env, table, selectColumns) {
  const row = await env.DB.prepare(`SELECT ${selectColumns} FROM ${table} WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`).first();
  if (!row) return null;
  const result = await env.DB.prepare(`UPDATE ${table} SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(row.id).run();
  return result.meta?.changes === 1 ? parseRow(row) : null;
}

async function handleDeviceApi(request, env, url) {
  if (!(await authenticatedDevice(request, env))) return json({ error: "device_auth_required" }, 401);
  await ensureDatabase(env);

  if (request.method === "POST" && url.pathname === "/api/device/heartbeat") {
    const body = await readJson(request);
    const id = typeof body.deviceId === "string" ? body.deviceId.slice(0, 120) : "";
    const label = typeof body.label === "string" ? body.label.slice(0, 120) : "";
    const version = typeof body.version === "string" ? body.version.slice(0, 80) : null;
    if (!id || !label) return json({ error: "invalid_device" }, 400);
    await env.DB.prepare("INSERT INTO paired_devices (id, label, version, last_seen_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET label = excluded.label, version = excluded.version, last_seen_at = CURRENT_TIMESTAMP")
      .bind(id, label, version).run();
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/device/tasks") {
    const task = await claimNext(env, "remote_tasks", "id, room_id, message_id, text, decisions_json, agents_json, created_at");
    return json({ task });
  }

  const taskResult = url.pathname.match(/^\/api\/device\/tasks\/([^/]+)\/result$/);
  if (request.method === "POST" && taskResult) {
    const body = await readJson(request);
    const status = body.ok === true ? "completed" : "failed";
    const error = body.ok === true ? null : String(body.error || "device_task_failed").slice(0, 1000);
    await env.DB.prepare("UPDATE remote_tasks SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'claimed'")
      .bind(status, error, decodeURIComponent(taskResult[1])).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/device/events") {
    const body = await readJson(request);
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.slice(0, 120) : "";
    const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
    if (!deviceId || !events.length) return json({ error: "invalid_events" }, 400);
    const taskId = events.find((event) => event.taskId)?.taskId;
    if (!taskId) return json({ error: "event_task_required" }, 400);
    const taskOwner = await env.DB.prepare("SELECT user_id FROM remote_tasks WHERE id = ?").bind(String(taskId)).first();
    if (!taskOwner?.user_id) return json({ error: "event_task_not_found" }, 409);
    const statements = events.map((event) => env.DB.prepare("INSERT INTO remote_events (user_id, device_id, task_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)")
      .bind(taskOwner.user_id, deviceId, event.taskId ? String(event.taskId).slice(0, 160) : null, String(event.type || "unknown").slice(0, 120), JSON.stringify(event.payload || {})));
    await env.DB.batch(statements);
    return json({ accepted: statements.length });
  }

  if (request.method === "GET" && url.pathname === "/api/device/approvals") {
    const approval = await claimNext(env, "remote_approvals", "id, request_id, decision, created_at");
    return json({ approval });
  }

  const approvalResult = url.pathname.match(/^\/api\/device\/approvals\/([^/]+)\/result$/);
  if (request.method === "POST" && approvalResult) {
    const body = await readJson(request);
    const status = body.ok === true ? "completed" : "failed";
    const error = body.ok === true ? null : String(body.error || "device_approval_failed").slice(0, 1000);
    await env.DB.prepare("UPDATE remote_approvals SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'claimed'")
      .bind(status, error, decodeURIComponent(approvalResult[1])).run();
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/device/")) return handleDeviceApi(request, env, url);
  if (url.pathname.startsWith("/api/")) return handleOwnerApi(request, env, url);

  const response = await env.ASSETS.fetch(request);
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) return response;
  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  indexUrl.search = "";
  return env.ASSETS.fetch(new Request(indexUrl, request));
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === "request_too_large" ? 413 : 500;
      return json({ error: status === 413 ? message : "site_runtime_error" }, status);
    }
  },
};
