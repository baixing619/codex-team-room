import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutputArtifactStore, resolveOutputArtifactPath } from "../server/outputArtifactStore.mjs";
import { RemotePairingBridge } from "../server/remotePairingBridge.mjs";

test("accepts only explicit, safe project deliverables and rewrites local paths", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-output-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "output"));
  fs.writeFileSync(path.join(root, "output", "preview.png"), Buffer.from("fake-png"));
  fs.writeFileSync(path.join(root, ".env"), "SECRET=hidden");
  const outside = path.join(path.dirname(root), "outside.txt");
  fs.writeFileSync(outside, "outside");
  t.after(() => fs.rmSync(outside, { force: true }));

  assert.equal(resolveOutputArtifactPath(root, ".env"), null);
  assert.equal(resolveOutputArtifactPath(root, outside), null);
  const store = new OutputArtifactStore();
  const source = "已完成：![预览图](output/preview.png)；参考 https://example.com";
  const resolved = store.resolveMessage(source, root);
  assert.equal(resolved.attachments.length, 1);
  assert.equal(resolved.attachments[0].kind, "output");
  assert.equal(resolved.attachments[0].type, "image/png");
  assert.equal(resolved.text.includes("output/preview.png"), false);
  assert.match(resolved.text, /已交付图片：预览图/);
  assert.equal(store.get(resolved.attachments[0].id)?.path, path.join(root, "output", "preview.png"));

  const uploads = [];
  const bridge = new RemotePairingBridge({ runtime: { cwd: root }, outputArtifactStore: store });
  bridge.config = { cwd: root };
  bridge.lastTaskId = "task-output";
  bridge.taskCwds.set("task-output", root);
  bridge.request = async (pathname, options) => {
    uploads.push({ pathname, body: JSON.parse(options.body) });
    return { attachment: { id: uploads.at(-1).body.artifactId, name: "preview.png", type: "image/png", size: 8 } };
  };
  const serialized = await bridge.serializeRuntimeEvent({ sequence: 1, type: "agentMessage", taskId: "task-output", roomId: "room-1", agentId: "developer", text: source });
  assert.equal(uploads[0].pathname, "/api/device/output-attachments");
  assert.equal(serialized.payload.text.includes(root), false);
  assert.equal(serialized.payload.attachments[0].url.startsWith("/api/output-attachments/output-"), true);
});
