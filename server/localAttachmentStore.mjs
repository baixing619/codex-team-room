import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;

export function safeAttachmentName(value) {
  const name = path.basename(String(value || "attachment")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (name || "attachment").slice(0, 180);
}

export class LocalAttachmentStore {
  constructor({ root = path.join(os.tmpdir(), "codex-team-room-attachments") } = {}) {
    this.root = root;
    this.items = new Map();
  }

  save({ name, type, buffer }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("invalid_attachment_size");
    const id = crypto.randomUUID();
    const safeName = safeAttachmentName(name);
    const directory = path.join(this.root, id);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, safeName);
    fs.writeFileSync(filePath, buffer, { flag: "wx" });
    const attachment = { id, name: safeName, type: String(type || "application/octet-stream").slice(0, 200), size: buffer.length, path: filePath };
    this.items.set(id, attachment);
    return { ...attachment };
  }

  resolve(references) {
    return (Array.isArray(references) ? references.slice(0, MAX_ATTACHMENTS) : []).map((reference) => {
      const attachment = this.items.get(String(reference?.id || ""));
      if (!attachment) throw new Error("attachment_not_found");
      return { ...attachment };
    });
  }

  remove(id) {
    const attachment = this.items.get(String(id || ""));
    if (!attachment) return false;
    this.items.delete(attachment.id);
    fs.rmSync(path.dirname(attachment.path), { recursive: true, force: true });
    return true;
  }
}
