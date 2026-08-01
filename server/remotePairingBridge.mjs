import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 10_000;

const POWERSHELL_REQUEST_SCRIPT = `
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$headers = @{}
$payload.headers.PSObject.Properties | ForEach-Object { $headers[$_.Name] = [string]$_.Value }
$params = @{
  Uri = [string]$payload.url
  Method = [string]$payload.method
  Headers = $headers
  UseBasicParsing = $true
  TimeoutSec = 30
}
if ($null -ne $payload.body) {
  $params.Body = [string]$payload.body
  $params.ContentType = 'application/json'
}
try {
  $response = Invoke-WebRequest @params
  [pscustomobject]@{ status = [int]$response.StatusCode; body = [string]$response.Content } | ConvertTo-Json -Compress
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 599 }
  [pscustomobject]@{ status = $status; body = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
`;

export function windowsNativeRequest(url, options = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("native_http_fallback_unavailable"));
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_REQUEST_SCRIPT], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `native_http_fallback_${code}`));
      try {
        const value = JSON.parse(stdout.trim());
        resolve(new Response(value.body || "", { status: value.status, headers: { "content-type": "application/json" } }));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({
      url,
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body ?? null,
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
  const common = { sequence: event.sequence, createdAt: event.createdAt, agentId: event.agentId || null };
  if (event.type === "agentMessage") return { ...common, text: event.text || "", threadId: event.threadId, turnId: event.turnId };
  if (event.type === "approvalRequested") {
    return { ...common, requestId: event.requestId, method: event.method, threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, command: event.command, target: projectLabel };
  }
  if (event.type === "approvalResolved") return { ...common, requestId: event.requestId, decision: event.decision };
  if (event.type === "agentThreadBound") return { ...common, threadId: event.threadId, model: event.model };
  if (event.type === "turnStarted") return { ...common, threadId: event.threadId, turnId: event.turnId, messageId: event.messageId };
  if (event.type === "turnCompleted") return { ...common, threadId: event.threadId, status: event.turn?.status || "completed" };
  if (event.type === "writeItemCompleted") return { ...common, threadId: event.threadId, item: { type: event.item?.type, status: event.item?.status } };
  return common;
}

export class RemotePairingBridge {
  constructor({ runtime, indexProvider = null, configPath = path.resolve(".team-room", "pairing.json"), fetchImpl = fetch, nativeRequestImpl = windowsNativeRequest, timers = globalThis } = {}) {
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
    let response = await this.fetchImpl(url, requestOptions);
    if (response.status === 403 && response.headers.get("content-type")?.includes("text/html")) {
      response = await this.nativeRequestImpl(url, requestOptions);
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || `remote_pairing_http_${response.status}`);
    return value;
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
      body: JSON.stringify({ deviceId: this.config.deviceId, label: this.config.deviceLabel, version: "0.2.0" }),
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
      await this.runtime.connect({ cwd, agents: task.agents, confirmed: true });
      await this.runtime.dispatch({ text: task.text, decisions: task.decisions, messageId: task.message_id });
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
        events: events.map((event) => ({ taskId: this.lastTaskId, type: event.type, payload: sanitizeRuntimeEvent(event) })),
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
