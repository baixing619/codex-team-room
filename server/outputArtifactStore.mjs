import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, safeAttachmentName } from "./localAttachmentStore.mjs";

const MAX_OUTPUT_ARTIFACTS = 4;
const BLOCKED_SEGMENTS = new Set([".git", ".team-room", "node_modules"]);
const BLOCKED_EXTENSIONS = new Set([".env", ".pem", ".key", ".pfx", ".p12", ".cer", ".crt", ".sqlite", ".sqlite3", ".db"]);
const ALLOWED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp",
  ".pdf", ".docx", ".xlsx", ".pptx", ".zip",
  ".txt", ".md", ".mdx", ".csv", ".tsv", ".log", ".json", ".jsonl", ".yaml", ".yml", ".xml",
  ".html", ".css", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sql", ".toml", ".ini",
  ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb", ".swift", ".kt", ".gradle",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"]);
const MIME_BY_EXTENSION = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"], [".bmp", "image/bmp"],
  [".pdf", "application/pdf"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], [".zip", "application/zip"],
  [".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".xml", "application/xml; charset=utf-8"], [".csv", "text/csv; charset=utf-8"],
]);

function decodeDestination(value) {
  let destination = String(value || "").trim();
  if (destination.startsWith("<") && destination.endsWith(">")) destination = destination.slice(1, -1).trim();
  try { destination = decodeURIComponent(destination); } catch {}
  return destination;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isSensitiveRelativePath(relativePath) {
  const segments = String(relativePath || "").split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()) || segment.startsWith("."))) return true;
  const basename = segments.at(-1)?.toLowerCase() || "";
  return /(?:^|[._-])(secret|credential|password|passwd|private[_-]?key|access[_-]?token|refresh[_-]?token)(?:[._-]|$)/i.test(basename);
}

export function outputArtifactType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (MIME_BY_EXTENSION.has(extension)) return MIME_BY_EXTENSION.get(extension);
  if ([".md", ".mdx", ".txt", ".tsv", ".log", ".yaml", ".yml", ".ini", ".toml", ".sql"].includes(extension)) return "text/plain; charset=utf-8";
  if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb", ".swift", ".kt", ".gradle"].includes(extension)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export function resolveOutputArtifactPath(cwd, destination) {
  const rootInput = String(cwd || "").trim();
  const targetInput = decodeDestination(destination);
  if (!rootInput || !targetInput || /^(?:https?:|file:|data:|blob:|javascript:)/i.test(targetInput)) return null;
  const root = fs.realpathSync.native(rootInput);
  const candidateInput = path.isAbsolute(targetInput) ? targetInput : path.resolve(root, targetInput.replace(/\//g, path.sep));
  const candidate = fs.realpathSync.native(candidateInput);
  if (!isInside(root, candidate)) return null;
  const relative = path.relative(root, candidate);
  const extension = path.extname(candidate).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension) || BLOCKED_EXTENSIONS.has(extension) || isSensitiveRelativePath(relative)) return null;
  const stat = fs.statSync(candidate);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ATTACHMENT_BYTES) return null;
  return { root, path: candidate, relativePath: relative, size: stat.size, mtimeMs: stat.mtimeMs, name: safeAttachmentName(path.basename(candidate)), type: outputArtifactType(candidate), isImage: IMAGE_EXTENSIONS.has(extension) };
}

function markdownArtifactMatches(text) {
  const pattern = /(!?)\[([^\]\r\n]{0,300})\]\(([^)\r\n]+)\)/g;
  return [...String(text || "").matchAll(pattern)].slice(0, 20).map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    isImageSyntax: match[1] === "!",
    label: String(match[2] || "").trim(),
    destination: match[3],
  }));
}

export class OutputArtifactStore {
  constructor() {
    this.items = new Map();
    this.idsByFingerprint = new Map();
  }

  resolveMessage(text, cwd, { urlFor = (artifact) => `/api/output-attachments/${encodeURIComponent(artifact.id)}` } = {}) {
    const source = String(text || "");
    const found = [];
    const seenPaths = new Set();
    for (const reference of markdownArtifactMatches(source)) {
      if (found.length >= MAX_OUTPUT_ARTIFACTS) break;
      let resolved;
      try { resolved = resolveOutputArtifactPath(cwd, reference.destination); } catch { resolved = null; }
      if (!resolved || seenPaths.has(resolved.path.toLowerCase())) continue;
      seenPaths.add(resolved.path.toLowerCase());
      const fingerprint = `${resolved.path.toLowerCase()}\u0000${resolved.size}\u0000${resolved.mtimeMs}`;
      let id = this.idsByFingerprint.get(fingerprint);
      if (!id) {
        id = `output-${randomUUID()}`;
        this.idsByFingerprint.set(fingerprint, id);
      }
      const artifact = { id, ...resolved };
      this.items.set(id, artifact);
      found.push({ ...reference, artifact });
    }
    if (!found.length) return { text: source, attachments: [], artifacts: [] };
    let rewritten = source;
    for (const reference of [...found].sort((left, right) => right.start - left.start)) {
      const label = reference.label || reference.artifact.name;
      const replacement = `${reference.artifact.isImage || reference.isImageSyntax ? "已交付图片" : "已交付文件"}：${label}`;
      rewritten = `${rewritten.slice(0, reference.start)}${replacement}${rewritten.slice(reference.end)}`;
    }
    const attachments = found.map(({ artifact }) => ({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      size: artifact.size,
      kind: "output",
      url: urlFor(artifact),
    }));
    return { text: rewritten, attachments, artifacts: found.map(({ artifact }) => ({ ...artifact })) };
  }

  get(id) {
    const artifact = this.items.get(String(id || ""));
    if (!artifact) return null;
    try {
      const current = resolveOutputArtifactPath(artifact.root, artifact.path);
      if (!current || current.size !== artifact.size || current.mtimeMs !== artifact.mtimeMs) return null;
    } catch {
      return null;
    }
    return { ...artifact };
  }
}
