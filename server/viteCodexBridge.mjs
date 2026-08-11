import fs from "node:fs";
import { listProjects, listThreads, localBridgeStatus, readVisibleMessages } from "./codexSessionIndex.mjs";
import { getCodexRuntimeStatus } from "./codexAppServerRuntime.mjs";
import { teamRoomRuntime } from "./teamRoomRuntimeManager.mjs";
import { RemotePairingBridge } from "./remotePairingBridge.mjs";
import { LocalAttachmentStore, MAX_ATTACHMENT_BYTES } from "./localAttachmentStore.mjs";
import { OutputArtifactStore } from "./outputArtifactStore.mjs";
import { sanitizeTaskText } from "../src/lib/taskAssignments.js";

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

async function readJsonBody(request, maxBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBinaryBody(request, maxBytes = MAX_ATTACHMENT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function codexBridgePlugin() {
  return {
    name: "codex-team-room-local-bridge",
    configureServer(server) {
      const attachmentStore = new LocalAttachmentStore();
      const outputArtifactStore = new OutputArtifactStore();
      const remotePairing = new RemotePairingBridge({
        runtime: teamRoomRuntime,
        indexProvider: { listProjects, listThreads, readVisibleMessages },
        outputArtifactStore,
      });
      remotePairing.start();
      server.httpServer?.once("close", () => remotePairing.stop());
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/")) return next();

        try {
          const url = new URL(request.url, "http://local.codex-team-room");
          if (request.method === "GET" && url.pathname === "/api/health") {
            return sendJson(response, 200, localBridgeStatus());
          }
          if (request.method === "GET" && url.pathname === "/api/projects") {
            return sendJson(response, 200, { projects: listProjects() });
          }
          if (request.method === "GET" && url.pathname === "/api/runtime/status") {
            return sendJson(response, 200, teamRoomRuntime.status());
          }
          if (request.method === "GET" && url.pathname === "/api/pair/local-status") {
            return sendJson(response, 200, remotePairing.status());
          }
          if (request.method === "GET" && url.pathname === "/api/sync/state") {
            return remotePairing.request("/api/device/state", { requestTimeoutMs: 30_000 })
              .then((value) => sendJson(response, 200, value))
              .catch((error) => sendJson(response, 503, { error: "sync_unavailable", message: error.message }));
          }
          if (request.method === "PUT" && url.pathname === "/api/sync/state") {
            return readJsonBody(request, 1536 * 1024)
              .then((body) => remotePairing.request("/api/device/state", { method: "PUT", body: JSON.stringify(body), requestTimeoutMs: 30_000 }))
              .then((value) => sendJson(response, 200, value))
              .catch((error) => sendJson(response, error.message === "sync_conflict" ? 409 : 503, { error: error.message === "sync_conflict" ? "sync_conflict" : "sync_unavailable", message: error.message }));
          }
          if (request.method === "GET" && url.pathname === "/api/runtime/events") {
            const events = teamRoomRuntime.listEvents(Number(url.searchParams.get("after") || 0)).map((event) => {
              if (event.type === "agentMessage") {
                const resolved = outputArtifactStore.resolveMessage(event.text, teamRoomRuntime.cwd);
                return { ...event, text: sanitizeTaskText(resolved.text, 12_000), attachments: resolved.attachments };
              }
              if (event.type === "agentMessageDelta") return { ...event, text: sanitizeTaskText(event.text, 12_000) };
              return event;
            });
            return sendJson(response, 200, { events });
          }
          const outputAttachment = url.pathname.match(/^\/api\/output-attachments\/([^/]+)$/);
          if (request.method === "GET" && outputAttachment) {
            const artifact = outputArtifactStore.get(decodeURIComponent(outputAttachment[1]));
            if (!artifact) return sendJson(response, 404, { error: "output_attachment_not_found" });
            const inline = artifact.type.startsWith("image/") || artifact.type === "application/pdf";
            response.statusCode = 200;
            response.setHeader("content-type", artifact.type);
            response.setHeader("content-length", artifact.size);
            response.setHeader("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`);
            response.setHeader("cache-control", "private, max-age=60");
            response.setHeader("x-content-type-options", "nosniff");
            response.setHeader("content-security-policy", "sandbox; default-src 'none'");
            return fs.createReadStream(artifact.path).pipe(response);
          }
          if (request.method === "POST" && url.pathname === "/api/attachments") {
            return readBinaryBody(request)
              .then((buffer) => {
                const rawName = request.headers["x-file-name"] || "attachment";
                const name = decodeURIComponent(String(rawName));
                const attachment = attachmentStore.save({ name, type: request.headers["content-type"], buffer });
                return sendJson(response, 201, { attachment: { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size } });
              })
              .catch((error) => sendJson(response, error.message === "request_too_large" ? 413 : 400, { error: error.message }));
          }
          const attachmentDelete = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
          if (request.method === "DELETE" && attachmentDelete) {
            attachmentStore.remove(decodeURIComponent(attachmentDelete[1]));
            return sendJson(response, 200, { ok: true });
          }
          if (request.method === "POST" && url.pathname === "/api/runtime/connect") {
            return readJsonBody(request)
              .then((body) => teamRoomRuntime.connect(body))
              .then((status) => sendJson(response, 200, status))
              .catch((error) => sendJson(response, 400, { error: "runtime_connect_failed", message: error.message }));
          }
          if (request.method === "POST" && url.pathname === "/api/runtime/disconnect") {
            return sendJson(response, 200, teamRoomRuntime.disconnect());
          }
          if (request.method === "POST" && url.pathname === "/api/runtime/dispatch") {
            return readJsonBody(request)
              .then((body) => teamRoomRuntime.dispatch({ ...body, attachments: attachmentStore.resolve(body.attachments) }))
              .then((result) => sendJson(response, 200, result))
              .catch((error) => sendJson(response, 400, { error: "runtime_dispatch_failed", message: error.message }));
          }
          if (request.method === "POST" && url.pathname === "/api/runtime/approval") {
            return readJsonBody(request)
              .then((body) => teamRoomRuntime.resolveApproval(body))
              .then((result) => sendJson(response, 200, result))
              .catch((error) => sendJson(response, 400, { error: "runtime_approval_failed", message: error.message }));
          }
          if (request.method === "GET" && url.pathname === "/api/threads") {
            return sendJson(response, 200, { threads: listThreads(url.searchParams.get("project") || "") });
          }
          if (request.method === "GET" && url.pathname.startsWith("/api/threads/") && url.pathname.endsWith("/messages")) {
            const threadId = decodeURIComponent(url.pathname.slice("/api/threads/".length, -"/messages".length));
            const result = readVisibleMessages(threadId);
            return result
              ? sendJson(response, 200, result)
              : sendJson(response, 404, { error: "thread_not_found" });
          }
          return sendJson(response, 404, { error: "not_found" });
        } catch (error) {
          return sendJson(response, 500, {
            error: "local_bridge_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}
