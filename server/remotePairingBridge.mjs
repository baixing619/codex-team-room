import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from "./localAttachmentStore.mjs";
import { sanitizeTaskText } from "../src/lib/taskAssignments.js";

const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSPORT_ATTEMPTS = 2;
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504, 599]);

function safeRemoteTaskError(value) {
  return sanitizeTaskText(value instanceof Error ? value.message : value, 1000) || "remote_task_failed";
}

function sanitizeCursorFingerprints(value, limit) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).slice(-limit).flatMap(([id, fingerprint]) => {
    const safeId = String(id || "").trim().slice(0, 240);
    const safeFingerprint = String(fingerprint || "").trim().slice(0, 240);
    return safeId && safeFingerprint ? [[safeId, safeFingerprint]] : [];
  }));
}

function sanitizeContextCursorUpdate(value) {
  if (!value || typeof value !== "object") return null;
  const agentId = String(value.agentId || "").trim().slice(0, 160);
  if (!agentId) return null;
  return {
    version: 1,
    initialized: true,
    agentId,
    threadId: String(value.threadId || "").trim().slice(0, 200) || null,
    deliverySequence: Math.max(0, Number(value.deliverySequence) || 0),
    messageFingerprints: sanitizeCursorFingerprints(value.messageFingerprints, 240),
    knowledgeFingerprints: sanitizeCursorFingerprints(value.knowledgeFingerprints, 100),
    lastContextId: String(value.lastContextId || "").trim().slice(0, 200) || null,
  };
}

const POWERSHELL_REQUEST_SCRIPT = `
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$headers = @{}
$payload.headers.PSObject.Properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value }
$timeoutSec = [Math]::Max(1, [Math]::Min(30, [Math]::Ceiling([double]$payload.timeoutMs / 1000)))
$params = @{
  Uri = [string]$payload.url
  Method = [string]$payload.method
  Headers = $headers
  UseBasicParsing = $true
  TimeoutSec = $timeoutSec
}
if ($null -ne $payload.bodyBase64) {
  $params.Body = [Text.Encoding]::UTF8.GetBytes([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$payload.bodyBase64)))
  $params.ContentType = 'application/json'
}
try {
  $response = Invoke-WebRequest @params
  $stream = New-Object System.IO.MemoryStream
  try {
    $response.RawContentStream.CopyTo($stream)
    $bodyBase64 = [Convert]::ToBase64String($stream.ToArray())
  } finally {
    $stream.Dispose()
  }
  [pscustomobject]@{ status = [int]$response.StatusCode; bodyBase64 = $bodyBase64 } | ConvertTo-Json -Compress
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 599 }
  $bodyBase64 = $null
  if ($_.Exception.Response) {
    try {
      $stream = $_.Exception.Response.GetResponseStream()
      if ($stream) {
        $memory = New-Object System.IO.MemoryStream
        try {
          $stream.CopyTo($memory)
          $bodyBase64 = [Convert]::ToBase64String($memory.ToArray())
        } finally {
          $memory.Dispose()
          $stream.Dispose()
        }
      }
    } catch {}
  }
  if ($null -eq $bodyBase64) {
    $bodyBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))
  }
  [pscustomobject]@{ status = $status; bodyBase64 = $bodyBase64 } | ConvertTo-Json -Compress
}
`;

export function encodeUtf8Base64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

export function decodeUtf8Base64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

export function windowsNativeRequest(url, options = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("native_http_fallback_unavailable"));
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_REQUEST_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutId = null;
    const terminate = () => {
      if (child.killed || child.exitCode !== null) return;
      try {
        child.kill();
      } catch {
        // A child can exit between the state check and the termination request.
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => {
      terminate();
      finish(reject, new Error("remote_request_aborted"));
    };
    const timeout = () => {
      terminate();
      finish(reject, new Error("remote_request_timeout"));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => {
      if (code !== 0) return finish(reject, new Error(stderr.trim() || `native_http_fallback_${code}`));
      try {
        const value = JSON.parse(stdout.trim());
        finish(resolve, new Response(decodeUtf8Base64(value.bodyBase64), { status: value.status, headers: { "content-type": "application/json" } }));
      } catch (error) {
        finish(reject, error);
      }
    });
    if (options.signal?.aborted) return abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    timeoutId = setTimeout(timeout, timeoutMs);
    child.stdin.end(JSON.stringify({
      url,
      method: options.method || "GET",
      headers: options.headers || {},
      bodyBase64: options.body == null ? null : encodeUtf8Base64(options.body),
      timeoutMs,
    }));
  });
}

function readConfig(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!parsed.siteUrl || !parsed.deviceSecret || !parsed.siwcBypassToken || !parsed.cwd) return null;
    return {
      ...parsed,
      siteUrl: String(parsed.siteUrl).replace(/\/$/, ""),
      deviceId: parsed.deviceId || `device-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      deviceLabel: parsed.deviceLabel || os.hostname(),
    };
  } catch {
    return null;
  }
}

function safeApprovalRequestId(value) {
  const text = String(value);
  return /^\d+$/.test(text) ? Number(text) : text;
}

export function sanitizeRuntimeEvent(event, projectLabel = "已配对项目") {
  const assignmentPhase = ["analysis", "execution"].includes(event.assignmentPhase) ? event.assignmentPhase : null;
  const common = {
    sequence: event.sequence,
    createdAt: event.createdAt,
    roomId: event.roomId || null,
    taskId: event.taskId || null,
    agentId: event.agentId || null,
    ...(event.eventId ? { eventId: event.eventId } : {}),
  };
  if (["taskStarted", "taskWaitingApproval", "taskCompleted", "taskFailed"].includes(event.type)) {
    return { ...common, status: event.status, error: event.error ? safeRemoteTaskError(event.error) : null };
  }
  if (event.type === "coordinatorDecisionLocked") return { ...common, turnId: event.turnId || null, status: "locked", public: true };
  if (event.type === "agentMessage") return {
    ...common,
    text: sanitizeTaskText(event.text || "", 12_000),
    threadId: event.threadId,
    turnId: event.turnId,
    ...(event.public !== undefined ? { public: event.public !== false } : {}),
    ...(event.internal !== undefined ? { internal: event.internal === true } : {}),
    ...(event.assignmentId ? { assignmentId: event.assignmentId } : {}),
  };
  if (event.type === "agentMessageDelta") return {
    ...common,
    text: sanitizeTaskText(event.text || "", 12_000),
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId || null,
    public: event.public !== false,
  };
  if (event.type === "turnProgress") return {
    ...common,
    threadId: event.threadId,
    turnId: event.turnId,
    turnKind: event.turnKind || null,
    assignmentId: event.assignmentId || null,
    assignmentPhase,
    stage: event.stage,
    itemType: event.itemType || null,
    public: event.public !== false,
  };
  if (event.type === "taskDelegationMerged") return {
    ...common,
    assignmentId: event.assignmentId || null,
    targetAgentId: event.targetAgentId || null,
    stage: "already_running",
    public: true,
  };
  if (event.type === "approvalRequested") {
    return {
      ...common,
      requestId: event.requestId,
      approvalKey: event.approvalKey,
      method: event.method,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      command: sanitizeTaskText(event.command || event.reason || "", 2000),
      ...(event.reason ? { reason: sanitizeTaskText(event.reason, 2000) } : {}),
      ...(event.error ? { error: safeRemoteTaskError(event.error) } : {}),
      target: projectLabel,
      operationType: event.operationType,
      requiresWriteLock: event.requiresWriteLock,
      canAccept: event.canAccept,
    };
  }
  if (event.type === "approvalResolved") return { ...common, requestId: event.requestId, approvalKey: event.approvalKey, threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, decision: event.decision, requiresWriteLock: event.requiresWriteLock };
  if (event.type === "approvalFailed") return { ...common, requestId: event.requestId, approvalKey: event.approvalKey, threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, error: safeRemoteTaskError(event.error || "approval_failed") };
  if (event.type === "agentThreadBound") return { ...common, threadId: event.threadId, model: event.model, bindingMode: event.bindingMode };
  if (event.type === "turnStarted") return { ...common, threadId: event.threadId, turnId: event.turnId, messageId: event.messageId, turnKind: event.turnKind || null, assignmentId: event.assignmentId || null, assignmentPhase, contextCursorUpdate: sanitizeContextCursorUpdate(event.contextCursorUpdate), public: event.public !== false };
  if (event.type === "turnCompleted") return { ...common, threadId: event.threadId, turnId: event.turnId, status: event.turn?.status || event.status || "completed", assignmentPhase };
  if (event.type === "writeItemCompleted") return { ...common, threadId: event.threadId, item: { type: event.item?.type, status: event.item?.status } };
  return common;
}

export class RemotePairingBridge {
  constructor({ runtime, indexProvider = null, outputArtifactStore = null, configPath = path.resolve(".team-room", "pairing.json"), fetchImpl = fetch, nativeRequestImpl = windowsNativeRequest, timers = globalThis, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.runtime = runtime;
    this.indexProvider = indexProvider;
    this.outputArtifactStore = outputArtifactStore;
    this.configPath = configPath;
    this.fetchImpl = fetchImpl;
    this.nativeRequestImpl = nativeRequestImpl;
    this.timers = timers;
    this.config = null;
    this.interval = null;
    this.eventUploadTimer = null;
    this.eventUploadPromise = null;
    this.unsubscribeRuntimeEvents = null;
    this.busy = false;
    this.eventCursor = 0;
    this.lastHeartbeatAt = 0;
    this.lastTaskId = null;
    this.activeTasks = new Map();
    this.finishedTasks = new Map();
    this.taskCwds = new Map();
    this.lastError = null;
    this.nativePreferred = false;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || REQUEST_TIMEOUT_MS);
  }

  status() {
    return {
      configured: Boolean(this.config),
      running: Boolean(this.interval),
      siteUrl: this.config?.siteUrl || null,
      deviceId: this.config?.deviceId || null,
      deviceLabel: this.config?.deviceLabel || null,
      cwd: this.config?.cwd || null,
      lastError: this.lastError,
    };
  }

  start() {
    if (this.interval) return this.status();
    this.config = readConfig(this.configPath);
    if (!this.config) return this.status();
    this.interval = this.timers.setInterval(() => this.tick(), POLL_INTERVAL_MS);
    if (typeof this.runtime?.subscribe === "function") {
      this.unsubscribeRuntimeEvents = this.runtime.subscribe(() => this.scheduleEventUpload());
    }
    this.tick();
    return this.status();
  }

  stop() {
    if (this.interval) this.timers.clearInterval(this.interval);
    if (this.eventUploadTimer) this.timers.clearTimeout(this.eventUploadTimer);
    this.eventUploadTimer = null;
    this.unsubscribeRuntimeEvents?.();
    this.unsubscribeRuntimeEvents = null;
    this.interval = null;
    return this.status();
  }

  scheduleEventUpload() {
    if (!this.config || this.eventUploadTimer) return;
    this.eventUploadTimer = this.timers.setTimeout(() => {
      this.eventUploadTimer = null;
      this.uploadEvents().catch((error) => {
        this.lastError = safeRemoteTaskError(error);
      });
    }, 80);
  }

  async updateTaskStatus(taskId, status, error = null) {
    return this.request(`/api/device/tasks/${encodeURIComponent(taskId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status, error, deviceId: this.config?.deviceId || null }),
    });
  }

  async request(pathname, options = {}) {
    const url = `${this.config.siteUrl}${pathname}`;
    const requestTimeoutMs = Math.max(1, Number(options.requestTimeoutMs) || this.requestTimeoutMs);
    const { requestTimeoutMs: _requestTimeoutMs, ...transportRequestOptions } = options;
    const requestOptions = {
      ...transportRequestOptions,
      headers: {
        "content-type": "application/json",
        "OAI-Sites-Authorization": `Bearer ${this.config.siwcBypassToken}`,
        "x-team-room-device-secret": this.config.deviceSecret,
        ...(this.config?.deviceId ? { "x-team-room-device-id": this.config.deviceId } : {}),
        ...(options.headers || {}),
      },
    };
    let timedOut = false;
    const controller = new AbortController();
    let timeoutId;
    try {
      return await Promise.race([
        (async () => {
          const transportOptions = { ...requestOptions, signal: controller.signal, timeoutMs: requestTimeoutMs };
          let lastError;
          for (let attempt = 0; attempt < MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
            try {
              let nextResponse;
              if (this.nativePreferred) {
                nextResponse = await this.nativeRequestImpl(url, transportOptions);
              } else {
                nextResponse = await this.fetchImpl(url, transportOptions);
                if (nextResponse.status === 403 && nextResponse.headers.get("content-type")?.includes("text/html")) {
                  this.nativePreferred = true;
                  nextResponse = await this.nativeRequestImpl(url, transportOptions);
                }
              }
              const value = await nextResponse.json().catch(() => ({}));
              if (nextResponse.ok) return value;
              lastError = new Error(value.error || `remote_pairing_http_${nextResponse.status}`);
              if (!RETRYABLE_HTTP_STATUSES.has(nextResponse.status)) throw lastError;
            } catch (error) {
              lastError = error;
              const retryable = error instanceof TypeError
                || ["remote_pairing_http_502", "remote_pairing_http_503", "remote_pairing_http_504", "remote_pairing_http_599"].includes(error?.message);
              if (!retryable) throw error;
            }
            if (attempt + 1 >= MAX_TRANSPORT_ATTEMPTS) throw lastError;
          }
          throw lastError || new Error("remote_pairing_transport_failed");
        })(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("remote_request_timeout"));
          }, requestTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (timedOut) throw new Error("remote_request_timeout");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async optionalRequest(pathname, emptyValue) {
    try {
      return await this.request(pathname);
    } catch (error) {
      if (error instanceof Error && ["not_found", "remote_pairing_http_404"].includes(error.message)) return emptyValue;
      throw error;
    }
  }

  async heartbeat() {
    await this.request("/api/device/heartbeat", {
      method: "POST",
      body: JSON.stringify({ deviceId: this.config.deviceId, label: this.config.deviceLabel, version: "0.3.0" }),
    });
    this.lastHeartbeatAt = Date.now();
  }

  async executeTask(task) {
    this.lastTaskId = task.id;
    try {
      const cwd = task.cwd || this.config.cwd;
      this.taskCwds.set(task.id, cwd);
      if (this.taskCwds.size > 50) this.taskCwds.delete(this.taskCwds.keys().next().value);
      const projects = this.indexProvider?.listProjects?.() || [];
      const knownProject = cwd.toLowerCase() === this.config.cwd.toLowerCase()
        || projects.some((project) => project.exists !== false && String(project.path).toLowerCase() === cwd.toLowerCase());
      if (!knownProject) throw new Error("remote_project_not_found");
      const existingBindings = (Array.isArray(task.agents) ? task.agents : [])
        .filter((agent) => agent?.threadBinding === "existing");
      if (existingBindings.length) {
        if (typeof this.indexProvider?.listThreads !== "function") throw new Error("remote_thread_binding_index_unavailable");
        const permittedThreadIds = new Set((this.indexProvider.listThreads(cwd) || [])
          .map((thread) => typeof thread?.id === "string" ? thread.id.trim() : "")
          .filter(Boolean));
        for (const agent of existingBindings) {
          const boundThreadId = typeof agent.boundThreadId === "string" ? agent.boundThreadId.trim() : "";
          if (!boundThreadId || !permittedThreadIds.has(boundThreadId)) {
            throw new Error("remote_thread_binding_not_found");
          }
        }
      }
      const roomId = task.room_id || task.roomId || null;
      const attachments = await this.downloadTaskAttachments(task);
      await this.runtime.connect({ cwd, agents: task.agents, confirmed: true, roomId, taskId: task.id });
      await this.runtime.dispatch({ text: task.text, decisions: task.decisions, messageId: task.message_id, roomId, taskId: task.id, sharedContext: task.sharedContext, attachments });
      if (typeof this.runtime.waitForTask !== "function") {
        await this.request(`/api/device/tasks/${encodeURIComponent(task.id)}/result`, { method: "POST", body: JSON.stringify({ ok: true }) });
        return { status: "succeeded", error: null };
      }
      await this.updateTaskStatus(task.id, "running");
      const result = typeof this.runtime.waitForTask === "function"
        ? await this.runtime.waitForTask(task.id)
        : { status: "succeeded", error: null };
      const succeeded = result?.status === "succeeded" || result?.status === "completed";
      await this.request(`/api/device/tasks/${encodeURIComponent(task.id)}/result`, {
        method: "POST",
        body: JSON.stringify({ status: succeeded ? "succeeded" : "failed", error: succeeded ? null : safeRemoteTaskError(result?.error), deviceId: this.config?.deviceId || null }),
      });
      return result;
    } catch (error) {
      await this.request(`/api/device/tasks/${encodeURIComponent(task.id)}/result`, {
        method: "POST",
        body: JSON.stringify({ status: "failed", error: safeRemoteTaskError(error), deviceId: this.config?.deviceId || null }),
      });
      throw error;
    }
  }

  async processTask(task) {
    if (!task?.id) throw new Error("remote_task_id_required");
    if (this.finishedTasks.has(task.id)) return this.finishedTasks.get(task.id);
    const existing = this.activeTasks.get(task.id);
    if (existing) return existing;
    const promise = this.executeTask(task).then((result) => {
      this.finishedTasks.set(task.id, result);
      return result;
    }).catch((error) => {
      this.finishedTasks.set(task.id, { status: "failed", error: safeRemoteTaskError(error) });
      throw error;
    }).finally(() => {
      if (this.activeTasks.get(task.id) === promise) this.activeTasks.delete(task.id);
    });
    this.activeTasks.set(task.id, promise);
    return promise;
  }

  async downloadTaskAttachments(task) {
    const references = Array.isArray(task?.attachments) ? task.attachments.slice(0, 4) : [];
    if (!references.length) return [];
    const directory = path.join(os.tmpdir(), "codex-team-room-attachments", String(task.id).replace(/[^a-zA-Z0-9-]/g, "_"));
    fs.mkdirSync(directory, { recursive: true });
    const result = [];
    for (const reference of references) {
      const attachmentId = String(reference?.id || "");
      if (!attachmentId) throw new Error("attachment_id_required");
      const value = await this.request(`/api/device/attachments/${encodeURIComponent(attachmentId)}`, { requestTimeoutMs: 45_000 });
      const buffer = Buffer.from(String(value.dataBase64 || ""), "base64");
      if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("invalid_attachment_size");
      const name = safeAttachmentName(value.name || reference.name);
      const filePath = path.join(directory, `${attachmentId}-${name}`);
      fs.writeFileSync(filePath, buffer, { flag: "w" });
      result.push({ id: attachmentId, name, type: String(value.type || reference.type || "application/octet-stream"), size: buffer.length, path: filePath });
    }
    return result;
  }

  async uploadEvents() {
    if (this.eventUploadPromise) return this.eventUploadPromise;
    this.eventUploadPromise = (async () => {
      while (true) {
        const events = this.runtime.listEvents(this.eventCursor)
          .filter((event) => Number(event?.sequence) > this.eventCursor);
        if (!events.length) return;
        const serializedEvents = [];
        for (const event of events) serializedEvents.push(await this.serializeRuntimeEvent(event));
        await this.request("/api/device/events", {
          method: "POST",
          body: JSON.stringify({
            deviceId: this.config.deviceId,
            events: serializedEvents,
          }),
        });
        const nextCursor = Math.max(...events.map((event) => Number(event.sequence)));
        if (!Number.isFinite(nextCursor) || nextCursor <= this.eventCursor) return;
        this.eventCursor = nextCursor;
      }
    })().finally(() => {
      this.eventUploadPromise = null;
    });
    return this.eventUploadPromise;
  }

  async uploadOutputArtifact(artifact, event) {
    const buffer = fs.readFileSync(artifact.path);
    if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("invalid_output_attachment_size");
    const value = await this.request("/api/device/output-attachments", {
      method: "POST",
      requestTimeoutMs: 45_000,
      body: JSON.stringify({
        taskId: event.taskId || this.lastTaskId,
        agentId: event.agentId || null,
        artifactId: artifact.id,
        name: artifact.name,
        type: artifact.type,
        size: buffer.length,
        dataBase64: buffer.toString("base64"),
      }),
    });
    if (!value.attachment?.id) throw new Error("output_attachment_upload_failed");
    return { ...value.attachment, kind: "output", url: `/api/output-attachments/${encodeURIComponent(value.attachment.id)}` };
  }

  async serializeRuntimeEvent(event) {
    const payload = sanitizeRuntimeEvent(event);
    if (event.type === "agentMessage" && this.outputArtifactStore) {
      const cwd = this.taskCwds.get(event.taskId) || this.runtime?.cwd || this.config?.cwd;
      const resolved = this.outputArtifactStore.resolveMessage(event.text, cwd, { urlFor: () => null });
      if (resolved.artifacts.length) {
        payload.text = sanitizeTaskText(resolved.text, 12_000);
        payload.attachments = [];
        for (const artifact of resolved.artifacts) payload.attachments.push(await this.uploadOutputArtifact(artifact, event));
      }
    }
    return {
      taskId: event.taskId || this.lastTaskId,
      type: event.type,
      ...(event.eventId ? { eventId: event.eventId } : {}),
      payload,
    };
  }

  async processApproval(approval) {
    const requestId = safeApprovalRequestId(approval.request_id ?? approval.requestId);
    const approvalKey = approval.approval_key ?? approval.approvalKey ?? null;
    let route = approval.routeJson ?? approval.route_json ?? null;
    if (typeof route === "string") {
      try { route = JSON.parse(route); } catch { route = null; }
    }
    route = route && typeof route === "object" ? route : {};
    const agentId = approval.agent_id ?? approval.agentId ?? route.agentId ?? null;
    try {
      this.runtime.resolveApproval({ requestId, decision: approval.decision });
    } catch (error) {
      const safeError = safeRemoteTaskError(error);
      const alreadyEmitted = this.runtime.listEvents(0).some((event) => event.type === "approvalFailed"
        && String(event.requestId) === String(requestId)
        && (!approvalKey || event.approvalKey === approvalKey));
      if (!alreadyEmitted) {
        this.runtime.emitRoomEvent("approvalFailed", {
          requestId,
          approvalKey,
          agentId,
          roomId: route.roomId || null,
          taskId: route.taskId || null,
          threadId: route.threadId || null,
          turnId: route.turnId || null,
          error: safeError,
        });
      }
      // Emit first so the following tick can still upload the failure if the
      // result acknowledgement itself is unavailable.
      try {
        await this.request(`/api/device/approvals/${encodeURIComponent(approval.id)}/result`, {
          method: "POST",
          body: JSON.stringify({ ok: false, error: safeError, deviceId: this.config?.deviceId || null }),
        });
      } catch {
        // The event queue remains the durable retry path.
      }
      throw new Error(safeError);
    }
    // The local decision is already authoritative. A network failure while
    // acknowledging it must never be rewritten as approvalFailed because the
    // accepted command may already be executing. The emitted
    // approvalResolved event reconciles the claimed cloud row durably.
    try {
      await this.request(`/api/device/approvals/${encodeURIComponent(approval.id)}/result`, {
        method: "POST",
        body: JSON.stringify({ ok: true, deviceId: this.config?.deviceId || null }),
      });
    } catch (error) {
      throw new Error(safeRemoteTaskError(error));
    }
  }

  async processIndexRequest(indexRequest) {
    if (!this.indexProvider) throw new Error("local_index_unavailable");
    let result;
    if (indexRequest.request_type === "projects") {
      result = { projects: this.indexProvider.listProjects() };
    } else if (indexRequest.request_type === "threads") {
      result = { threads: this.indexProvider.listThreads(indexRequest.request?.projectPath || "") };
    } else if (indexRequest.request_type === "messages") {
      result = this.indexProvider.readVisibleMessages(indexRequest.request?.threadId || "");
      if (!result) throw new Error("thread_not_found");
    } else {
      throw new Error("unsupported_index_request");
    }

    await this.request(`/api/device/index-requests/${encodeURIComponent(indexRequest.id)}/result`, {
      method: "POST",
      body: JSON.stringify({ ok: true, result }),
    });
  }

  async drainIndexRequests(firstRequest, limit = 6) {
    let current = firstRequest;
    let processed = 0;
    while (current && processed < limit) {
      try {
        await this.processIndexRequest(current);
      } catch (error) {
        await this.request(`/api/device/index-requests/${encodeURIComponent(current.id)}/result`, {
          method: "POST",
          body: JSON.stringify({ ok: false, error: safeRemoteTaskError(error) }),
        });
      }
      processed += 1;
      if (processed < limit) {
        const next = await this.optionalRequest("/api/device/index-requests", { indexRequest: null });
        current = next.indexRequest;
      }
    }
  }

  async tick() {
    if (this.busy || !this.config) return;
    this.busy = true;
    try {
      if (Date.now() - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) await this.heartbeat();
      const [{ task }, { approval }, { indexRequest }] = await Promise.all([
        this.request("/api/device/tasks"),
        this.request("/api/device/approvals"),
        this.optionalRequest("/api/device/index-requests", { indexRequest: null }),
      ]);
      if (task) this.processTask(task).catch((error) => { this.lastError = error instanceof Error ? error.message : String(error); });
      if (approval) await this.processApproval(approval);
      if (indexRequest) await this.drainIndexRequests(indexRequest);
      await this.uploadEvents();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      try {
        await this.uploadEvents();
      } catch (uploadError) {
        this.lastError = uploadError instanceof Error ? uploadError.message : String(uploadError);
      }
    } finally {
      this.busy = false;
    }
  }
}
