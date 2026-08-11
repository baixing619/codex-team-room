import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSubagentThreadSource } from "../src/lib/internalThreads.js";

const MAX_ROLLOUTS = 2500;
const META_CHUNK_BYTES = 16 * 1024;
const MAX_META_LINE_BYTES = 1024 * 1024;
const MAX_VISIBLE_MESSAGES = 60;
const MAX_VISIBLE_MESSAGE_CHARS = 2_400;
const HISTORY_TAIL_READ_BYTES = 4 * 1024 * 1024;
const HISTORY_CHUNK_BYTES = 64 * 1024;
const MAX_HISTORY_LINE_BYTES = 512 * 1024;
const CWD_TAIL_READ_BYTES = 512 * 1024;
const TITLE_PREFIX_READ_BYTES = MAX_META_LINE_BYTES + (256 * 1024);
const MAX_FALLBACK_TITLE_CHARS = 48;
const MAX_FALLBACK_TITLE_CACHE_ENTRIES = 3000;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function readFirstJsonLine(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const chunks = [];
    let offset = 0;
    let total = 0;
    while (offset < fileSize && total < MAX_META_LINE_BYTES) {
      const size = Math.min(META_CHUNK_BYTES, fileSize - offset, MAX_META_LINE_BYTES - total);
      const buffer = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      const newlineIndex = chunk.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(chunk.subarray(0, newlineIndex));
        return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").replace(/\r$/, "");
      }
      chunks.push(chunk);
      total += bytesRead;
    }
    return null;
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
          title: typeof value.thread_name === "string" && value.thread_name.trim()
            ? value.thread_name.trim()
            : null,
          updatedAt: value.updated_at || null,
        });
      }
    } catch {
      // Ignore a partially-written final index line.
    }
  }
  return names;
}

function readInitialLines(filePath, onLine) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const limit = Math.min(fileSize, TITLE_PREFIX_READ_BYTES);
    let offset = 0;
    let pending = Buffer.alloc(0);
    let discardingLongLine = false;

    while (offset < limit) {
      const size = Math.min(HISTORY_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(fd, chunk, 0, size, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const buffer = chunk.subarray(0, bytesRead);

      if (discardingLongLine) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) continue;
        pending = buffer.subarray(newline + 1);
        discardingLongLine = false;
      } else {
        pending = Buffer.concat([pending, buffer]);
      }

      let lineStart = 0;
      for (let index = 0; index < pending.length; index += 1) {
        if (pending[index] !== 0x0a) continue;
        const line = pending.subarray(lineStart, index);
        lineStart = index + 1;
        if (line.length > 0 && onLine(line) === false) return;
      }
      pending = pending.subarray(lineStart);

      if (pending.length > MAX_META_LINE_BYTES) {
        pending = Buffer.alloc(0);
        discardingLongLine = true;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function titleFromText(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  const characters = Array.from(compact);
  return characters.length > MAX_FALLBACK_TITLE_CHARS
    ? `${characters.slice(0, MAX_FALLBACK_TITLE_CHARS).join("")}…`
    : compact;
}

let fallbackTitleCache = new Map();
let recentCwdCache = new Map();

function cacheFallbackTitle(filePath, version, title) {
  if (fallbackTitleCache.size >= MAX_FALLBACK_TITLE_CACHE_ENTRIES) {
    fallbackTitleCache.delete(fallbackTitleCache.keys().next().value);
  }
  fallbackTitleCache.set(filePath, { version, title });
}

function fallbackTitleForRollout(filePath) {
  let version = "";
  try {
    const stat = fs.statSync(filePath);
    version = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = fallbackTitleCache.get(filePath);
  if (cached?.version === version) return cached.title;

  let title = null;
  try {
    readInitialLines(filePath, (lineBuffer) => {
      const line = lineBuffer.toString("utf8").trim();
      if (!line) return true;
      try {
        const event = JSON.parse(line);
        const payload = event.type === "response_item" ? event.payload : null;
        if (payload?.type !== "message" || payload.role !== "user") return true;
        const text = extractVisibleText(payload.content, payload.role, { includeTeamRoomContext: true });
        title = titleFromText(text);
      } catch {
        // Ignore malformed or actively-written lines.
      }
      return !title;
    });
  } catch {
    title = null;
  }

  cacheFallbackTitle(filePath, version, title);
  return title;
}

function cacheRecentCwd(filePath, version, cwd) {
  if (recentCwdCache.size >= MAX_FALLBACK_TITLE_CACHE_ENTRIES) {
    recentCwdCache.delete(recentCwdCache.keys().next().value);
  }
  recentCwdCache.set(filePath, { version, cwd });
}

function recentTurnContextCwd(filePath) {
  let version = "";
  try {
    const stat = fs.statSync(filePath);
    version = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
  const cached = recentCwdCache.get(filePath);
  if (cached?.version === version) return cached.cwd;

  let cwd = null;
  try {
    readRecentLines(filePath, (lineBuffer) => {
      const line = lineBuffer.toString("utf8").trim();
      if (!line) return true;
      try {
        const event = JSON.parse(line);
        const candidate = event.type === "turn_context" ? event.payload?.cwd : null;
        if (typeof candidate === "string" && candidate.trim()) cwd = candidate.trim();
      } catch {
        // Ignore malformed or actively-written lines.
      }
      return !cwd;
    }, { tailReadBytes: CWD_TAIL_READ_BYTES });
  } catch {
    cwd = null;
  }

  cacheRecentCwd(filePath, version, cwd);
  return cwd;
}

function isGuardianSource(source) {
  const other = source?.subagent?.other;
  return typeof other === "string" && other.trim().toLowerCase() === "guardian";
}

function threadSpawnTitle(source) {
  const spawned = source?.subagent?.thread_spawn;
  if (!spawned || typeof spawned !== "object") return null;
  const nickname = typeof spawned.agent_nickname === "string" ? spawned.agent_nickname.trim() : "";
  const agentPath = typeof spawned.agent_path === "string"
    ? spawned.agent_path.split(/[\\/]/).filter(Boolean).at(-1)?.trim() || ""
    : "";
  if (nickname && agentPath) return `${nickname} · ${agentPath}`;
  return nickname || agentPath || null;
}

function threadSpawnParentId(source) {
  const parentId = source?.subagent?.thread_spawn?.parent_thread_id;
  return typeof parentId === "string" && parentId.trim() ? parentId.trim() : null;
}

function projectPathKey(projectPath) {
  return typeof projectPath === "string" ? projectPath.toLowerCase() : "";
}

function attachAncestorProjectRelations(threads) {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const projectsByAncestorId = new Map();

  for (const child of threads) {
    if (!child.cwd) continue;
    const seenIds = new Set([child.id]);
    let parentId = threadSpawnParentId(child.source);

    while (parentId && !seenIds.has(parentId)) {
      seenIds.add(parentId);
      const parent = threadsById.get(parentId);
      if (!parent) break;

      const relatedProjects = projectsByAncestorId.get(parent.id) || new Map();
      relatedProjects.set(projectPathKey(child.cwd), child.cwd);
      projectsByAncestorId.set(parent.id, relatedProjects);
      parentId = threadSpawnParentId(parent.source);
    }
  }

  return threads.map((thread) => {
    const relatedProjects = projectsByAncestorId.get(thread.id);
    return relatedProjects
      ? { ...thread, relatedProjectPaths: Array.from(relatedProjects.values()) }
      : thread;
  });
}

function projectPathsForThread(thread) {
  const projects = new Map();
  for (const projectPath of [thread.cwd, ...(thread.relatedProjectPaths || [])]) {
    if (projectPath) projects.set(projectPathKey(projectPath), projectPath);
  }
  return Array.from(projects.values());
}

function parseMeta(filePath, names) {
  let line = "";
  try {
    line = readFirstJsonLine(filePath);
  } catch {
    return null;
  }
  if (!line?.trim()) return null;
  try {
    const item = JSON.parse(line);
    if (item.type !== "session_meta" || !item.payload?.id) return null;
    const known = names.get(item.payload.id);
    const source = item.payload.source || null;
    if (isGuardianSource(source)) return null;
    const cwd = recentTurnContextCwd(filePath) || item.payload.cwd || "";
    const indexedTitle = known?.title || threadSpawnTitle(source);
    const fallbackTitle = indexedTitle ? null : fallbackTitleForRollout(filePath);
    const title = indexedTitle || fallbackTitle || "历史对话";
    return {
      id: item.payload.id,
      title,
      updatedAt: known?.updatedAt || item.payload.timestamp || null,
      timestamp: item.payload.timestamp || null,
      cwd,
      originator: item.payload.originator || null,
      source,
      rolloutPath: filePath,
    };
  } catch {
    return null;
  }
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

  cache = { createdAt: now, threads: attachAncestorProjectRelations(threads) };
  return cache.threads;
}

export function listProjects() {
  const threads = getThreadIndex();
  const projects = new Map();

  for (const thread of threads) {
    if (isSubagentThreadSource(thread.source)) continue;
    for (const projectPath of projectPathsForThread(thread)) {
      const existing = projects.get(projectPath) || {
        path: projectPath,
        name: path.basename(projectPath) || projectPath,
        threadCount: 0,
        latestAt: null,
        exists: fs.existsSync(projectPath),
      };
      existing.threadCount += 1;
      if (!existing.latestAt || String(thread.updatedAt || "") > String(existing.latestAt)) {
        existing.latestAt = thread.updatedAt;
      }
      projects.set(projectPath, existing);
    }
  }

  return Array.from(projects.values()).sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    return b.threadCount - a.threadCount;
  });
}

export function listThreads(projectPath) {
  return getThreadIndex()
    .filter((thread) => !isSubagentThreadSource(thread.source))
    .flatMap((thread) => {
      const directMatch = !projectPath || projectPathKey(thread.cwd) === projectPathKey(projectPath);
      const relatedMatch = !directMatch && (thread.relatedProjectPaths || [])
        .some((relatedPath) => projectPathKey(relatedPath) === projectPathKey(projectPath));
      if (!directMatch && !relatedMatch) return [];

      const { rolloutPath, relatedProjectPaths, ...visibleThread } = thread;
      return [{
        ...visibleThread,
        title: thread.title,
      }];
    });
}

function extractVisibleText(content, role, options = {}) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => ({
      part,
      text: part?.text || part?.input_text || part?.output_text || "",
    }))
    .filter(({ part, text }) => text && (role !== "user" || isVisibleUserContent(part, text, options)))
    .map(({ text }) => text)
    .join("\n")
    .trim();
}

function isVisibleUserContent(part, text, { includeTeamRoomContext = false } = {}) {
  if (!text) return false;
  const contentType = typeof part?.type === "string" ? part.type.toLowerCase() : "";
  if (contentType.includes("annotation") || contentType.includes("context")) return false;
  if (Array.isArray(part?.annotations) && part.annotations.length > 0) return false;

  const trimmed = text.trim();
  const internalPrefixes = [
    "<codex_internal_context",
    "<codex_delegation",
    "<environment_context",
    "<permissions instructions",
    "<app-context",
    "<in-app-browser-context",
    "<collaboration_mode",
    "<apps_instructions",
    "<plugins_instructions",
    "<skills_instructions",
    "<recommended_plugins",
    "<instructions>",
    "# AGENTS.md instructions",
    "the following is the codex agent history",
    "you are codex, an agent based on gpt-",
    "knowledge cutoff:",
    "# personality",
    "# working with the user",
    "# rules for getting work done",
    ...(!includeTeamRoomContext ? ["[team_room_shared_context_v1]"] : []),
  ];
  const normalized = trimmed.toLowerCase();
  return !internalPrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

function readRecentLines(filePath, onLine, {
  tailReadBytes = HISTORY_TAIL_READ_BYTES,
  maxLineBytes = MAX_HISTORY_LINE_BYTES,
} = {}) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const minimumOffset = Math.max(0, fileSize - tailReadBytes);
    let offset = fileSize;
    let pending = Buffer.alloc(0);
    let discardingLongLine = false;

    while (offset > minimumOffset) {
      const bytesToRead = Math.min(HISTORY_CHUNK_BYTES, offset - minimumOffset);
      offset -= bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = fs.readSync(fd, chunk, 0, bytesToRead, offset);
      const buffer = chunk.subarray(0, bytesRead);

      if (discardingLongLine) {
        const newline = buffer.lastIndexOf(0x0a);
        if (newline === -1) continue;
        pending = buffer.subarray(0, newline);
        discardingLongLine = false;
      } else {
        pending = Buffer.concat([buffer, pending]);
      }

      let lineEnd = pending.length;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (pending[index] !== 0x0a) continue;
        const line = pending.subarray(index + 1, lineEnd);
        lineEnd = index;
        if (line.length > 0 && onLine(line) === false) return;
      }
      pending = pending.subarray(0, lineEnd);

      if (pending.length > maxLineBytes) {
        pending = Buffer.alloc(0);
        discardingLongLine = true;
      }
    }

    if (!discardingLongLine && minimumOffset === 0 && pending.length > 0) onLine(pending);
  } finally {
    fs.closeSync(fd);
  }
}

export function readVisibleMessages(threadId) {
  const thread = cache.threads.find((item) => item.id === threadId)
    || getThreadIndex().find((item) => item.id === threadId);
  if (!thread?.rolloutPath || !fs.existsSync(thread.rolloutPath)) return null;

  const messages = [];
  try {
    readRecentLines(thread.rolloutPath, (lineBuffer) => {
      if (lineBuffer.length > MAX_HISTORY_LINE_BYTES) return true;
      const line = lineBuffer.toString("utf8").trim();
      if (!line) return true;
      try {
        const event = JSON.parse(line);
        if (event.type !== "response_item") return true;
        const payload = event.payload;
        if (payload?.type !== "message" || !["user", "assistant"].includes(payload.role)) return true;
        const text = extractVisibleText(payload.content, payload.role);
        if (!text) return true;
        messages.push({
          role: payload.role,
          text: text.length > MAX_VISIBLE_MESSAGE_CHARS ? `${text.slice(0, MAX_VISIBLE_MESSAGE_CHARS)}…` : text,
        });
      } catch {
        // Ignore malformed or actively-written lines.
      }
      return messages.length < MAX_VISIBLE_MESSAGES;
    });
  } catch {
    return null;
  }

  messages.reverse();

  return {
    thread: {
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
    },
    messages: messages.map((message, index) => ({ ...message, id: `${threadId}-${index}` })),
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
