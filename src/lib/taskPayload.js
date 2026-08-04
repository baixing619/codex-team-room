import { findContextCursor } from "./contextCursors.js";
import { isAgentMentioned, isBroadcastRequest } from "./participation.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const CONTEXT_PAYLOAD_VERSION = 2;
const MAX_CONTEXT_ITEMS = 40;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "csv", "tsv", "log", "json", "jsonl", "yaml", "yml", "xml", "html", "css",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "ps1", "sh", "bat", "cmd", "sql", "toml", "ini",
  "java", "go", "rs", "c", "h", "cpp", "hpp", "cs", "php", "rb", "swift", "kt", "gradle",
]);

function limitedText(value, max) {
  return String(value || "").trim().slice(0, max);
}

export function isSupportedAttachment(file) {
  const type = String(file?.type || "").toLowerCase().split(";", 1)[0];
  const extension = String(file?.name || "").toLowerCase().split(".").at(-1);
  return type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("text/")
    || ["application/json", "application/xml", "application/javascript", "application/sql", "application/yaml", "application/x-yaml"].includes(type)
    || TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

export function validateSelectedFiles(files, currentCount = 0) {
  const accepted = [];
  const errors = [];
  for (const file of Array.from(files || [])) {
    if (currentCount + accepted.length >= MAX_ATTACHMENTS) {
      errors.push(`每条消息最多 ${MAX_ATTACHMENTS} 个附件`);
      break;
    }
    if (!file?.size) {
      errors.push(`${file?.name || "附件"}为空文件`);
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name}超过 10 MB`);
    } else if (!isSupportedAttachment(file)) {
      errors.push(`${file.name}暂不支持；请选择图片、音频、文本或代码文件`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, errors };
}

function normalizeKnowledgeEntry(entry) {
  return {
    id: limitedText(entry?.id, 160),
    title: limitedText(entry?.title, 300),
    category: limitedText(entry?.category, 120),
    body: limitedText(entry?.body, 8_000),
  };
}

function normalizeTeamMessage(message, agentById) {
  return {
    id: limitedText(message?.id, 160),
    role: message?.kind,
    agentId: limitedText(message?.agentId, 160),
    agentName: limitedText(agentById.get(message?.agentId)?.name, 200),
    sourceThreadId: limitedText(message?.threadId, 200),
    text: limitedText(message?.text, 2_000),
  };
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

export function stableContextFingerprint(value) {
  const serialized = stableSerialize(value);
  let hash = 2_166_136_261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = Math.imul(hash ^ serialized.charCodeAt(index), 16_777_619) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

function fingerprintMap(items) {
  return Object.fromEntries(items.filter((item) => item.id).map((item) => [item.id, stableContextFingerprint(item)]));
}

function changedItems(items, fingerprints = {}) {
  return items.filter((item) => item.id && fingerprints[item.id] !== stableContextFingerprint(item));
}

export function buildRoomSharedContext({ room, messages, knowledge, agents, contextId, memberCursors = {}, activeAgentIds = null, deliverySequence = 0, text = "", currentMessage = null }) {
  const agentById = new Map((agents || []).map((agent) => [agent.id, agent]));
  const fullKnowledge = (knowledge || []).slice(0, MAX_CONTEXT_ITEMS).map(normalizeKnowledgeEntry).filter((entry) => entry.id || entry.title || entry.body);
  const fullMessages = (messages || [])
    .filter((message) => ["user", "agent", "system"].includes(message.kind))
    .slice(-MAX_CONTEXT_ITEMS)
    .map((message) => normalizeTeamMessage(message, agentById))
    .filter((message) => message.id || message.text);
  const knowledgeFingerprints = fingerprintMap(fullKnowledge);
  const currentCursorMessage = currentMessage ? normalizeTeamMessage(currentMessage, agentById) : null;
  const messageFingerprints = fingerprintMap(fullMessages);
  if (currentCursorMessage?.id) messageFingerprints[currentCursorMessage.id] = stableContextFingerprint(currentCursorMessage);
  const activeIds = activeAgentIds == null
    ? new Set((agents || []).map((agent) => agent.id))
    : new Set(activeAgentIds);
  const deliveriesByAgentId = {};
  const cursorUpdates = {};
  let needsFullSnapshot = false;

  for (const agent of agents || []) {
    const { key: cursorKey, cursor } = findContextCursor(memberCursors, agent);
    const threadId = typeof agent.boundThreadId === "string" && agent.boundThreadId.trim() ? agent.boundThreadId.trim() : null;
    const full = !cursor?.initialized;
    const delta = full ? null : {
      mode: "delta",
      knowledge: changedItems(fullKnowledge, cursor.knowledgeFingerprints),
      recentMessages: changedItems(fullMessages, cursor.messageFingerprints),
      removedKnowledgeIds: Object.keys(cursor.knowledgeFingerprints || {}).filter((id) => !knowledgeFingerprints[id]),
    };
    if (!activeIds.has(agent.id)) {
      const recovery = full ? { mode: "full", snapshotRef: "room-snapshot" } : { ...delta };
      // The current request is intentionally excluded from the ordinary
      // snapshot/delta because an immediately-started member already receives
      // it as descriptor.text.  A deferred member may only start later through
      // a coordinator assignment, whose descriptor.text is the assignment
      // rather than the user's request, so keep one structured recovery copy.
      if (currentCursorMessage?.id || currentCursorMessage?.text) recovery.currentMessage = currentCursorMessage;
      deliveriesByAgentId[agent.id] = {
        mode: "deferred",
        cursorKey,
        threadId,
        recovery,
      };
      if (full || isBroadcastRequest(text) || isAgentMentioned(text, agent)) needsFullSnapshot = true;
    } else {
      if (full) needsFullSnapshot = true;
      deliveriesByAgentId[agent.id] = full
        ? { mode: "full", cursorKey, threadId, snapshotRef: "room-snapshot" }
        : { ...delta, cursorKey, threadId };
    }
    cursorUpdates[cursorKey] = {
      version: 1,
      initialized: true,
      agentId: agent.id,
      threadId,
      deliverySequence: Number.isFinite(Number(deliverySequence)) ? Number(deliverySequence) : 0,
      messageFingerprints,
      knowledgeFingerprints,
      lastContextId: limitedText(contextId, 200),
    };
  }

  return {
    version: CONTEXT_PAYLOAD_VERSION,
    id: limitedText(contextId, 160),
    roomId: limitedText(room?.id, 160),
    roomName: limitedText(room?.name, 300),
    snapshot: needsFullSnapshot ? { knowledge: fullKnowledge, recentMessages: fullMessages } : null,
    deliveriesByAgentId,
    cursorUpdates,
  };
}

export function formatAttachmentSize(value) {
  const size = Number(value) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}
