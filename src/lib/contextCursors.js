const MAX_CURSOR_KEYS_PER_ROOM = 64;
const MAX_MESSAGE_FINGERPRINTS = 240;
const MAX_KNOWLEDGE_FINGERPRINTS = 100;

function safeText(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function sanitizeFingerprintMap(value, limit) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value)
    .slice(-limit)
    .map(([id, fingerprint]) => [safeText(id, 240), safeText(fingerprint, 240)])
    .filter(([id, fingerprint]) => id && fingerprint));
}

export function contextCursorKey(agentId, threadId = null) {
  const safeAgentId = safeText(agentId, 160);
  const safeThreadId = safeText(threadId, 200);
  return safeThreadId ? `thread:${safeThreadId}` : `agent:${safeAgentId}`;
}

function sanitizeCursor(value, fallbackAgentId = "") {
  if (!value || typeof value !== "object") return null;
  const agentId = safeText(value.agentId || fallbackAgentId, 160);
  if (!agentId) return null;
  const threadId = safeText(value.threadId, 200) || null;
  const messageFingerprints = sanitizeFingerprintMap(value.messageFingerprints, MAX_MESSAGE_FINGERPRINTS);
  const knowledgeFingerprints = sanitizeFingerprintMap(value.knowledgeFingerprints, MAX_KNOWLEDGE_FINGERPRINTS);
  if (!Object.keys(messageFingerprints).length && !Object.keys(knowledgeFingerprints).length && value.initialized !== true) return null;
  return {
    version: 1,
    initialized: true,
    agentId,
    threadId,
    deliverySequence: Number.isFinite(Number(value.deliverySequence)) ? Number(value.deliverySequence) : 0,
    messageFingerprints,
    knowledgeFingerprints,
    lastContextId: safeText(value.lastContextId, 200) || null,
    updatedAt: safeText(value.updatedAt, 80) || null,
  };
}

export function sanitizeContextCursorsByRoom(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([roomId, cursors]) => {
    if (!cursors || typeof cursors !== "object") return [roomId, {}];
    const next = {};
    for (const [key, cursor] of Object.entries(cursors).slice(-MAX_CURSOR_KEYS_PER_ROOM)) {
      const safeKey = safeText(key, 300);
      const sanitized = sanitizeCursor(cursor);
      if (safeKey && sanitized) next[safeKey] = sanitized;
    }
    return [safeText(roomId, 160), next];
  }).filter(([roomId]) => roomId));
}

export function sanitizeContextDeliverySequences(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([roomId, sequence]) => [safeText(roomId, 160), Math.max(0, Number(sequence) || 0)]).filter(([roomId]) => roomId));
}

export function sanitizePendingContextCursorsByRoom(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([roomId, pending]) => {
    const next = Array.isArray(pending) ? pending.slice(-100).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const taskId = safeText(item.taskId, 200) || null;
      const messageId = safeText(item.messageId, 200) || null;
      const updates = sanitizeContextCursorsByRoom({ pending: item.updates }).pending;
      if ((!taskId && !messageId) || !Object.keys(updates).length) return [];
      return [{
        taskId,
        messageId,
        sequence: Math.max(0, Number(item.sequence) || 0),
        updates,
        createdAt: safeText(item.createdAt, 80) || null,
      }];
    }) : [];
    return [safeText(roomId, 160), next];
  }).filter(([roomId]) => roomId));
}

export function findContextCursor(cursors, agent) {
  const source = cursors && typeof cursors === "object" ? cursors : {};
  const agentId = safeText(agent?.id, 160);
  const threadId = safeText(agent?.boundThreadId, 200);
  if (!agentId) return { key: contextCursorKey("unknown"), cursor: null };
  if (threadId) {
    const key = contextCursorKey(agentId, threadId);
    return { key, cursor: source[key]?.threadId === threadId ? source[key] : null };
  }
  const key = contextCursorKey(agentId);
  return { key, cursor: source[key]?.threadId ? null : source[key] || null };
}

export function applyContextCursorUpdates(cursors, updates, threadIdsByAgentId = {}) {
  const next = { ...(cursors && typeof cursors === "object" ? cursors : {}) };
  for (const [sourceKey, rawCursor] of Object.entries(updates || {})) {
    const cursor = sanitizeCursor(rawCursor);
    if (!cursor) continue;
    const threadId = safeText(threadIdsByAgentId[cursor.agentId] || cursor.threadId, 200) || null;
    const targetKey = contextCursorKey(cursor.agentId, threadId);
    const current = next[targetKey];
    if (current && Number(current.deliverySequence || 0) > cursor.deliverySequence) continue;
    next[targetKey] = { ...cursor, threadId, updatedAt: new Date().toISOString() };
    if (sourceKey !== targetKey && sourceKey.startsWith("agent:")) delete next[sourceKey];
  }
  return sanitizeContextCursorsByRoom({ room: next }).room;
}

export function bindContextCursorToThread(cursors, agentId, threadId) {
  const safeAgentId = safeText(agentId, 160);
  const safeThreadId = safeText(threadId, 200);
  if (!safeAgentId || !safeThreadId) return cursors || {};
  const source = cursors && typeof cursors === "object" ? cursors : {};
  const threadKey = contextCursorKey(safeAgentId, safeThreadId);
  if (source[threadKey]) return source;
  const agentKey = contextCursorKey(safeAgentId);
  const cursor = source[agentKey];
  // A cursor with a known different thread must never be copied to a new
  // binding. Omitting it causes one safe full snapshot after a rebind.
  if (!cursor || (cursor.threadId && cursor.threadId !== safeThreadId)) return source;
  const next = { ...source, [threadKey]: { ...cursor, agentId: safeAgentId, threadId: safeThreadId, updatedAt: new Date().toISOString() } };
  delete next[agentKey];
  return sanitizeContextCursorsByRoom({ room: next }).room;
}

export function acknowledgeContextDelivery({ cursors = {}, pending = [], taskId = null, messageId = null, agentId = null, threadId = null } = {}) {
  if (!agentId || !threadId || !Array.isArray(pending)) return { cursors, pending };
  const index = pending.findIndex((item) => (taskId && item.taskId === taskId) || (messageId && item.messageId === messageId));
  if (index < 0) return { cursors, pending };
  const item = pending[index];
  const acknowledged = Object.fromEntries(Object.entries(item.updates || {}).filter(([, cursor]) => cursor.agentId === agentId));
  if (!Object.keys(acknowledged).length) return { cursors, pending };
  const nextCursors = applyContextCursorUpdates(cursors, acknowledged, { [agentId]: threadId });
  const remainingUpdates = Object.fromEntries(Object.entries(item.updates || {}).filter(([, cursor]) => cursor.agentId !== agentId));
  const nextPending = pending.slice();
  if (Object.keys(remainingUpdates).length) nextPending[index] = { ...item, updates: remainingUpdates };
  else nextPending.splice(index, 1);
  return { cursors: nextCursors, pending: nextPending };
}

export function discardPendingContextDelivery(pending = [], { taskId = null, messageId = null } = {}) {
  if (!Array.isArray(pending)) return [];
  if (!taskId && !messageId) return pending;
  return pending.filter((item) => !((taskId && item.taskId === taskId) || (messageId && item.messageId === messageId)));
}
