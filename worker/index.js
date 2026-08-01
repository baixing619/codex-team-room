const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_BODY_BYTES = 256 * 1024;
const MAX_INDEX_RESULT_BYTES = 1024 * 1024;
const MAX_SYNC_STATE_BYTES = 1536 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const ONLINE_WINDOW_MS = 30_000;
const CLAIM_LEASE_SECONDS = 30;
const DEVICE_CLAIM_TABLES = new Set(["remote_tasks", "remote_approvals", "remote_index_requests"]);
const ALLOWED_APPROVAL_DECISIONS = new Set(["accept", "decline"]);
const ALLOWED_INDEX_REQUESTS = new Set(["projects", "threads", "messages"]);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("request_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("request_too_large");
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

async function authenticatedDevice(request, env) {
  return equalSecret(request.headers.get("x-team-room-device-secret"), env.TEAM_ROOM_DEVICE_SECRET);
}

function parseRow(row) {
  if (!row) return null;
  const result = { ...row };
  for (const key of ["decisions_json", "agents_json", "attachments_json", "shared_context_json", "payload_json", "request_json", "result_json", "state_json"]) {
    if (!(key in result)) continue;
    const nextKey = key.replace(/_json$/, "").replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    try {
      result[nextKey] = JSON.parse(result[key]);
    } catch {
      result[nextKey] = ["payload_json", "shared_context_json", "state_json"].includes(key) ? {} : [];
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
    env.DB.prepare("CREATE TABLE IF NOT EXISTS owner_state (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, state_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_tasks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT NOT NULL, message_id TEXT NOT NULL, cwd TEXT, text TEXT NOT NULL, decisions_json TEXT NOT NULL, agents_json TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]', shared_context_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_at TEXT, completed_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL, task_id TEXT, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_approvals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_at TEXT, completed_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS remote_index_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_type TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_at TEXT, completed_at TEXT)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_tasks_status_created ON remote_tasks(status, created_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_events_user_sequence ON remote_events(user_id, sequence)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_approvals_status_created ON remote_approvals(status, created_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_remote_index_requests_status_created ON remote_index_requests(status, created_at)"),
  ]);
  env.__teamRoomSchemaReady = true;
}

async function readOwnerState(env, userId = "site-owner") {
  const row = await env.DB.prepare("SELECT revision, state_json, updated_at FROM owner_state WHERE user_id = ?").bind(userId).first();
  if (!row) return { state: null, revision: 0, updatedAt: null };
  const parsed = parseRow(row);
  return { state: parsed.state, revision: Number(parsed.revision) || 0, updatedAt: parsed.updated_at || null };
}

async function writeOwnerState(request, env, userId = "site-owner") {
  const body = await readJson(request, MAX_SYNC_STATE_BYTES);
  const state = body.state && typeof body.state === "object" && !Array.isArray(body.state) ? body.state : null;
  const baseRevision = Number.isInteger(body.baseRevision) && body.baseRevision >= 0 ? body.baseRevision : -1;
  if (!state || baseRevision < 0) return json({ error: "invalid_sync_state" }, 400);
  const stateJson = JSON.stringify(state);
  if (new TextEncoder().encode(stateJson).byteLength > MAX_SYNC_STATE_BYTES) return json({ error: "sync_state_too_large" }, 413);
  const current = await readOwnerState(env, userId);
  if (current.revision !== baseRevision) return json({ error: "sync_conflict", ...current }, 409);

  const nextRevision = current.revision + 1;
  if (current.revision === 0) {
    try {
      await env.DB.prepare("INSERT INTO owner_state (user_id, revision, state_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)")
        .bind(userId, nextRevision, stateJson).run();
    } catch {
      return json({ error: "sync_conflict", ...(await readOwnerState(env, userId)) }, 409);
    }
  } else {
    const result = await env.DB.prepare("UPDATE owner_state SET revision = ?, state_json = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revision = ?")
      .bind(nextRevision, stateJson, userId, current.revision).run();
    if (result.meta?.changes !== 1) return json({ error: "sync_conflict", ...(await readOwnerState(env, userId)) }, 409);
  }
  return json({ state, revision: nextRevision, updatedAt: new Date().toISOString() });
}

async function handleOwnerApi(request, env, url) {
  if (!isSameOrigin(request)) return json({ error: "same_origin_required" }, 403);
  await ensureDatabase(env);
  const userId = "site-owner";

  if (request.method === "GET" && url.pathname === "/api/state") return json(await readOwnerState(env, userId));
  if (request.method === "PUT" && url.pathname === "/api/state") return writeOwnerState(request, env, userId);

  if (request.method === "POST" && url.pathname === "/api/attachments") {
    if (!env.ATTACHMENTS) return json({ error: "attachment_storage_unavailable" }, 503);
    const declaredSize = Number(request.headers.get("content-length") || 0);
    if (declaredSize > MAX_ATTACHMENT_BYTES) return json({ error: "attachment_too_large" }, 413);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES) return json({ error: "invalid_attachment_size" }, bytes.byteLength > MAX_ATTACHMENT_BYTES ? 413 : 400);
    let name = "attachment";
    try { name = decodeURIComponent(request.headers.get("x-file-name") || "attachment"); } catch {}
    name = name.split(/[\\/]/).at(-1).replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim().slice(0, 180) || "attachment";
    const type = String(request.headers.get("content-type") || "application/octet-stream").slice(0, 200);
    const id = crypto.randomUUID();
    await env.ATTACHMENTS.put(`${userId}/${id}`, bytes, { httpMetadata: { contentType: type }, customMetadata: { userId, name, type, size: String(bytes.byteLength) } });
    return json({ attachment: { id, name, type, size: bytes.byteLength } }, 201);
  }

  const ownerAttachment = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (request.method === "DELETE" && ownerAttachment) {
    if (env.ATTACHMENTS) await env.ATTACHMENTS.delete(`${userId}/${decodeURIComponent(ownerAttachment[1])}`);
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/pair/status") {
    const device = await env.DB.prepare("SELECT id, label, version, last_seen_at FROM paired_devices ORDER BY last_seen_at DESC LIMIT 1").first();
    const lastSeenAt = device?.last_seen_at || null;
    const online = Boolean(lastSeenAt && Date.now() - new Date(`${lastSeenAt}Z`).getTime() <= ONLINE_WINDOW_MS);
    return json({ paired: Boolean(device), online, device: device ? { id: device.id, label: device.label, version: device.version, lastSeenAt } : null });
  }

  if (request.method === "POST" && url.pathname === "/api/remote/index-requests") {
    const body = await readJson(request);
    const requestType = typeof body.type === "string" ? body.type : "";
    if (!ALLOWED_INDEX_REQUESTS.has(requestType)) return json({ error: "invalid_index_request" }, 400);
    const requestValue = {};
    if (requestType === "threads") requestValue.projectPath = String(body.projectPath || "").slice(0, 1000);
    if (requestType === "messages") requestValue.threadId = String(body.threadId || "").slice(0, 200);
    if ((requestType === "threads" && !requestValue.projectPath) || (requestType === "messages" && !requestValue.threadId)) {
      return json({ error: "invalid_index_request" }, 400);
    }
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO remote_index_requests (id, user_id, request_type, request_json) VALUES (?, ?, ?, ?)")
      .bind(id, userId, requestType, JSON.stringify(requestValue)).run();
    return json({ indexRequest: { id, status: "pending" } }, 201);
  }

  const indexRequestStatus = url.pathname.match(/^\/api\/remote\/index-requests\/([^/]+)$/);
  if (request.method === "GET" && indexRequestStatus) {
    const row = await env.DB.prepare("SELECT id, request_type, status, result_json, error, created_at, completed_at FROM remote_index_requests WHERE id = ? AND user_id = ?")
      .bind(decodeURIComponent(indexRequestStatus[1]), userId).first();
    return row ? json({ indexRequest: parseRow(row) }) : json({ error: "index_request_not_found" }, 404);
  }

  if (request.method === "POST" && url.pathname === "/api/remote/tasks") {
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const decisions = Array.isArray(body.decisions) ? body.decisions.slice(0, 12) : [];
    const agents = Array.isArray(body.agents) ? body.agents.slice(0, 12) : [];
    const cwd = typeof body.cwd === "string" ? body.cwd.slice(0, 1000) : "";
    const attachmentRefs = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS) : [];
    const attachments = [];
    if (attachmentRefs.length && !env.ATTACHMENTS) return json({ error: "attachment_storage_unavailable" }, 503);
    for (const reference of attachmentRefs) {
      const id = typeof reference?.id === "string" ? reference.id.slice(0, 160) : "";
      const object = id ? await env.ATTACHMENTS.head(`${userId}/${id}`) : null;
      if (!object || object.customMetadata?.userId !== userId) return json({ error: "attachment_not_found" }, 400);
      attachments.push({ id, name: object.customMetadata?.name || "attachment", type: object.customMetadata?.type || "application/octet-stream", size: Number(object.customMetadata?.size || object.size || 0) });
    }
    const sharedContext = body.sharedContext && typeof body.sharedContext === "object" ? body.sharedContext : {};
    if (!text || text.length > 20_000) return json({ error: "invalid_task_text" }, 400);
    if (!decisions.length || !agents.length) return json({ error: "task_members_required" }, 400);
    if (!cwd) return json({ error: "task_project_required" }, 400);
    const id = crypto.randomUUID();
    const messageId = typeof body.messageId === "string" && body.messageId ? body.messageId.slice(0, 160) : crypto.randomUUID();
    const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId.slice(0, 160) : "default";
    await env.DB.prepare("INSERT INTO remote_tasks (id, user_id, room_id, message_id, cwd, text, decisions_json, agents_json, attachments_json, shared_context_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, roomId, messageId, cwd, text, JSON.stringify(decisions), JSON.stringify(agents), JSON.stringify(attachments), JSON.stringify(sharedContext)).run();
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

async function reclaimExpiredClaim(env, table) {
  if (!DEVICE_CLAIM_TABLES.has(table)) throw new Error("invalid_claim_table");
  await env.DB.prepare(`UPDATE ${table} SET status = 'pending', claimed_at = NULL, error = 'device_request_lease_expired' WHERE status = 'claimed' AND claimed_at < datetime('now', '-${CLAIM_LEASE_SECONDS} seconds')`).run();
}

async function claimNext(env, table, selectColumns) {
  await reclaimExpiredClaim(env, table);
  const row = await env.DB.prepare(`SELECT ${selectColumns} FROM ${table} WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`).first();
  if (!row) return null;
  const result = await env.DB.prepare(`UPDATE ${table} SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`).bind(row.id).run();
  return result.meta?.changes === 1 ? parseRow(row) : null;
}

async function handleDeviceApi(request, env, url) {
  if (!(await authenticatedDevice(request, env))) return json({ error: "device_auth_required" }, 401);
  await ensureDatabase(env);

  if (request.method === "GET" && url.pathname === "/api/device/state") return json(await readOwnerState(env));
  if (request.method === "PUT" && url.pathname === "/api/device/state") return writeOwnerState(request, env);

  const deviceAttachment = url.pathname.match(/^\/api\/device\/attachments\/([^/]+)$/);
  if (request.method === "GET" && deviceAttachment) {
    if (!env.ATTACHMENTS) return json({ error: "attachment_storage_unavailable" }, 503);
    const id = decodeURIComponent(deviceAttachment[1]);
    const object = await env.ATTACHMENTS.get(`site-owner/${id}`);
    if (!object) return json({ error: "attachment_not_found" }, 404);
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return json({ id, name: object.customMetadata?.name || "attachment", type: object.customMetadata?.type || "application/octet-stream", size: bytes.length, dataBase64: btoa(binary) });
  }

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
    const task = await claimNext(env, "remote_tasks", "id, room_id, message_id, cwd, text, decisions_json, agents_json, attachments_json, shared_context_json, created_at");
    return json({ task });
  }

  if (request.method === "GET" && url.pathname === "/api/device/index-requests") {
    const indexRequest = await claimNext(env, "remote_index_requests", "id, request_type, request_json, created_at");
    return json({ indexRequest });
  }

  const indexResult = url.pathname.match(/^\/api\/device\/index-requests\/([^/]+)\/result$/);
  if (request.method === "POST" && indexResult) {
    const body = await readJson(request, MAX_INDEX_RESULT_BYTES);
    const status = body.ok === true ? "completed" : "failed";
    const resultJson = body.ok === true ? JSON.stringify(body.result ?? null) : null;
    const error = body.ok === true ? null : String(body.error || "device_index_failed").slice(0, 1000);
    await env.DB.prepare("UPDATE remote_index_requests SET status = ?, result_json = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'claimed'")
      .bind(status, resultJson, error, decodeURIComponent(indexResult[1])).run();
    return json({ ok: true });
  }

  const taskResult = url.pathname.match(/^\/api\/device\/tasks\/([^/]+)\/result$/);
  if (request.method === "POST" && taskResult) {
    const body = await readJson(request);
    const status = body.ok === true ? "completed" : "failed";
    const error = body.ok === true ? null : String(body.error || "device_task_failed").slice(0, 1000);
    const taskId = decodeURIComponent(taskResult[1]);
    const storedTask = await env.DB.prepare("SELECT attachments_json FROM remote_tasks WHERE id = ?").bind(taskId).first();
    await env.DB.prepare("UPDATE remote_tasks SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'claimed'")
      .bind(status, error, taskId).run();
    if (env.ATTACHMENTS && storedTask?.attachments_json) {
      try {
        const attachments = JSON.parse(storedTask.attachments_json);
        await Promise.all((Array.isArray(attachments) ? attachments : []).map((item) => env.ATTACHMENTS.delete(`site-owner/${item.id}`)));
      } catch {}
    }
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
