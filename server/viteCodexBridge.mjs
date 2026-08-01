import { listProjects, listThreads, localBridgeStatus, readVisibleMessages } from "./codexSessionIndex.mjs";
import { getCodexRuntimeStatus } from "./codexAppServerRuntime.mjs";
import { teamRoomRuntime } from "./teamRoomRuntimeManager.mjs";
import { RemotePairingBridge } from "./remotePairingBridge.mjs";

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

export function codexBridgePlugin() {
  return {
    name: "codex-team-room-local-bridge",
    configureServer(server) {
      const remotePairing = new RemotePairingBridge({ runtime: teamRoomRuntime });
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
          if (request.method === "GET" && url.pathname === "/api/runtime/events") {
            return sendJson(response, 200, { events: teamRoomRuntime.listEvents(Number(url.searchParams.get("after") || 0)) });
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
              .then((body) => teamRoomRuntime.dispatch(body))
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
