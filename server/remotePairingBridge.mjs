import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TRANSPORT_ATTEMPTS = 2;
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504, 599]);

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
  const common = {
    sequence: event.sequence,
    createdAt: event.createdAt,
    roomId: event.roomId || null,
    taskId: event.taskId || null,
    agentId: event.agentId || null,
  };
  if (event.type === "agentMessage") return { ...common, text: event.text || "", threadId: event.threadId, turnId: event.turnId };
  if (event.type === "approvalRequested") {
    return { ...common, requestId: event.requestId, method: event.method, threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, command: event.command, target: projectLabel };
  }
  if (event.type === "approvalResolved") return { ...common, requestId: event.requestId, decision: event.decision };
  if (event.type === "agentThreadBound") return { ...common, threadId: event.threadId, model: event.model, bindingMode: event.bindingMode };
  if (event.type === "turnStarted") return { ...common, threadId: event.threadId, turnId: event.turnId, messageId: event.messageId };
  if (event.type === "turnCompleted") return { ...common, threadId: event.threadId, status: event.turn?.status || "completed" };
  if (event.type === "writeItemCompleted") return { ...common, threadId: event.threadId, item: { type: event.item?.type, status: event.item?.status } };
  return common;
}

export class RemotePairingBridge {
  constructor({ runtime, indexProvider = null, configPath = path.resolve(".team-room", "pairing.json"), fetchImpl = fetch, nativeRequestImpl = windowsNativeRequest, timers = globalThis, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.runtime = runtime;
    this.indexProvider = indexProvider;
    this.configPath = configPath;
    this.fetchImpl = fetchImpl;
    this.nativeRequestImpl = nativeRequestImpl;
    this.timers = timers;
    this.config = null;
    this.interval = null;
    this.busy = false;
    this.eventCursor = 0;
    this.lastHeartbeatAt = 0;
    this.lastTaskId = null;
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
    this.tick();
    return this.status();
  }

  stop() {
    if (this.interval) this.timers.clearInterval(this.interval);
    this.interval = null;
    return this.status();
  }

  async request(pathname, options = {}) {
    const url = `${this.config.siteUrl}${pathname}`;
    const requestOptions = {
      ...options,
      headers: {
        "content-type": "application/json",
        "OAI-Sites-Authorization": `Bearer ${this.config.siwcBypassToken}`,
        "x-team-room-device-secret": this.config.deviceSecret,
        ...(options.headers || {}),
      },
    };
    let timedOut = false;
    const controller = new AbortController();
    let timeoutId;
    try {
      return await Promise.race([
        (async () => {
          const transportOptions = { ...requestOptions, signal: controller.signal, timeoutMs: this.requestTimeoutMs };
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
          }, this.requestTimeoutMs);
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
      body: JSON.stringify({ deviceId: this.config.deviceId, label: this.config.deviceLabel, version: "0.2.1" }),
    });
    this.lastHeartbeatAt = Date.now();
  }

  async processTask(task) {
    this.lastTaskId = task.id;
    try {
      const cwd = task.cwd || this.config.cwd;
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
      await this.runtime.connect({ cwd, agents: task.agents, confirmed: true, roomId, taskId: task.id });
      await this.runtime.dispatch({ text: task.text, decisions: task.decisions, messageId: task.message_id, roomId, taskId: task.id });
      await this.request(`/api/device/tasks/${encodeURIComponent(task.id)}/result`, { method: "POST", body: JSON.stringify({ ok: true }) });
    } catch (error) {
      await this.request(`/api/device/tasks/${encodeURIComponent(task.id)}/result`, {
        method: "POST",
        body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      });
      throw error;
    }
  }

  async uploadEvents() {
    const events = this.runtime.listEvents(this.eventCursor);
    if (!events.length) return;
    await this.request("/api/device/events", {
      method: "POST",
      body: JSON.stringify({
        deviceId: this.config.deviceId,
        events: events.map((event) => ({ taskId: event.taskId || this.lastTaskId, type: event.type, payload: sanitizeRuntimeEvent(event) })),
      }),
    });
    this.eventCursor = events.at(-1).sequence;
  }

  async processApproval(approval) {
    try {
      this.runtime.resolveApproval({ requestId: safeApprovalRequestId(approval.request_id), decision: approval.decision });
      await this.request(`/api/device/approvals/${encodeURIComponent(approval.id)}/result`, { method: "POST", body: JSON.stringify({ ok: true }) });
    } catch (error) {
      await this.request(`/api/device/approvals/${encodeURIComponent(approval.id)}/result`, {
        method: "POST",
        body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      });
      throw error;
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
      if (task) await this.processTask(task);
      if (approval) await this.processApproval(approval);
      if (indexRequest) {
        try {
          await this.processIndexRequest(indexRequest);
        } catch (error) {
          await this.request(`/api/device/index-requests/${encodeURIComponent(indexRequest.id)}/result`, {
            method: "POST",
            body: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
          });
          throw error;
        }
      }
      await this.uploadEvents();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}
