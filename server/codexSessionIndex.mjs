import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ROLLOUTS = 2500;
const META_READ_BYTES = 96 * 1024;
const MAX_VISIBLE_MESSAGES = 60;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function readUtf8Prefix(filePath, maxBytes = META_READ_BYTES) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function walkRollouts(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];

  while (pending.length > 0 && files.length < MAX_ROLLOUTS) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function readThreadNames(home) {
  const indexPath = path.join(home, "session_index.jsonl");
  const names = new Map();
  if (!fs.existsSync(indexPath)) return names;

  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value.id) {
        names.set(value.id, {
          title: value.thread_name || "未命名对话",
          updatedAt: value.updated_at || null,
        });
      }
    } catch {
      // Ignore a partially-written final index line.
    }
  }
  return names;
}

function parseMeta(filePath, names) {
  let prefix = "";
  try {
    prefix = readUtf8Prefix(filePath);
  } catch {
    return null;
  }

  for (const line of prefix.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.type !== "session_meta" || !item.payload?.id) continue;
      const known = names.get(item.payload.id);
      return {
        id: item.payload.id,
        title: known?.title || "历史对话",
        updatedAt: known?.updatedAt || item.payload.timestamp || null,
        timestamp: item.payload.timestamp || null,
        cwd: item.payload.cwd || "",
        originator: item.payload.originator || null,
        source: item.payload.source || null,
        rolloutPath: filePath,
      };
    } catch {
      // Keep scanning until session_meta is found.
    }
  }
  return null;
}

let cache = { createdAt: 0, threads: [] };

export function getThreadIndex({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - cache.createdAt < 15_000 && cache.threads.length > 0) {
    return cache.threads;
  }

  const home = codexHome();
  const names = readThreadNames(home);
  const rolloutFiles = walkRollouts(path.join(home, "sessions"));
  const threads = rolloutFiles
    .map((filePath) => parseMeta(filePath, names))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  cache = { createdAt: now, threads };
  return threads;
}

export function listProjects() {
  const threads = getThreadIndex();
  const projects = new Map();

  for (const thread of threads) {
    if (!thread.cwd) continue;
    const existing = projects.get(thread.cwd) || {
      path: thread.cwd,
      name: path.basename(thread.cwd) || thread.cwd,
      threadCount: 0,
      latestAt: null,
      exists: fs.existsSync(thread.cwd),
    };
    existing.threadCount += 1;
    if (!existing.latestAt || String(thread.updatedAt || "") > String(existing.latestAt)) {
      existing.latestAt = thread.updatedAt;
    }
    projects.set(thread.cwd, existing);
  }

  return Array.from(projects.values()).sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    return b.threadCount - a.threadCount;
  });
}

export function listThreads(projectPath) {
  return getThreadIndex()
    .filter((thread) => !projectPath || thread.cwd.toLowerCase() === projectPath.toLowerCase())
    .map(({ rolloutPath, ...thread }) => thread);
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.text || part?.input_text || part?.output_text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isVisibleUserText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  const internalPrefixes = [
    "<codex_internal_context",
    "<codex_delegation",
    "<environment_context",
    "<permissions instructions",
    "<app-context",
    "<collaboration_mode",
    "<apps_instructions",
    "<plugins_instructions",
    "<skills_instructions",
    "<recommended_plugins",
    "# AGENTS.md instructions",
  ];
  return !internalPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

export function readVisibleMessages(threadId) {
  const thread = getThreadIndex().find((item) => item.id === threadId);
  if (!thread?.rolloutPath || !fs.existsSync(thread.rolloutPath)) return null;

  const messages = [];
  const raw = fs.readFileSync(thread.rolloutPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "response_item") continue;
      const payload = event.payload;
      if (payload?.type !== "message" || !["user", "assistant"].includes(payload.role)) continue;
      const text = extractText(payload.content);
      if (payload.role === "user" && !isVisibleUserText(text)) continue;
      if (!text) continue;
      messages.push({
        id: `${threadId}-${messages.length}`,
        role: payload.role,
        text: text.length > 6000 ? `${text.slice(0, 6000)}…` : text,
      });
    } catch {
      // Ignore malformed or actively-written lines.
    }
  }

  return {
    thread: {
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
    },
    messages: messages.slice(-MAX_VISIBLE_MESSAGES),
  };
}

export function localBridgeStatus() {
  const home = codexHome();
  const workingDirectory = process.cwd();
  const workspacePath = path.basename(workingDirectory).toLowerCase() === "app"
    ? path.dirname(workingDirectory)
    : workingDirectory;
  return {
    ok: true,
    mode: "local-index",
    codexHomeExists: fs.existsSync(home),
    sessionsPathExists: fs.existsSync(path.join(home, "sessions")),
    indexedThreads: getThreadIndex().length,
    privacy: "metadata-only-until-thread-open",
    workspacePath,
  };
}
