import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalAttachmentStore, safeAttachmentName } from "../server/localAttachmentStore.mjs";

test("local attachment storage uses opaque ids, safe names, and rejects unknown references", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "team-room-attachment-test-"));
  try {
    const store = new LocalAttachmentStore({ root });
    const saved = store.save({ name: "../截图?.png", type: "image/png", buffer: Buffer.from("real-image-bytes") });
    assert.equal(saved.name, "截图_.png");
    assert.equal(path.dirname(path.dirname(saved.path)), root);
    assert.equal(fs.readFileSync(saved.path, "utf8"), "real-image-bytes");
    assert.deepEqual(store.resolve([{ id: saved.id }])[0], saved);
    assert.throws(() => store.resolve([{ id: "unknown" }]), /attachment_not_found/);
    assert.equal(store.remove(saved.id), true);
    assert.equal(fs.existsSync(saved.path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachment names cannot escape the temporary directory", () => {
  assert.equal(safeAttachmentName("..\\..\\secret.txt"), "secret.txt");
  assert.equal(safeAttachmentName("bad<name>.txt"), "bad_name_.txt");
});
