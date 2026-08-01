import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

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

test("requires owner or device authentication before API handlers reach storage", async () => {
  const ownerResponse = await worker.fetch(new Request("https://example.test/api/pair/status"), {});
  assert.equal(ownerResponse.status, 401);
  assert.equal((await ownerResponse.json()).error, "owner_auth_required");

  const deviceResponse = await worker.fetch(new Request("https://example.test/api/device/tasks"), {
    TEAM_ROOM_DEVICE_SECRET: "example-device-secret",
  });
  assert.equal(deviceResponse.status, 401);
  assert.equal((await deviceResponse.json()).error, "device_auth_required");
});

test("reports a recently seen paired device to the authenticated owner", async () => {
  const device = { id: "device-test", label: "工作电脑", version: "0.2.0", last_seen_at: new Date().toISOString().slice(0, 19).replace("T", " ") };
  const response = await worker.fetch(new Request("https://example.test/api/pair/status", {
    headers: { "oai-authenticated-user-id": "owner-test" },
  }), {
    TEAM_ROOM_OWNER_USER_ID: "owner-test",
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

test("keeps every source input required by Sites packaging", async () => {
  await access(new URL("../index.html", import.meta.url));
  await access(new URL("../worker/index.js", import.meta.url));
  await access(new URL("../.openai/hosting.json", import.meta.url));
  await access(new URL("../drizzle", import.meta.url));
});
