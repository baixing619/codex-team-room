import { DEFAULT_AGENTS, DEFAULT_ROOM } from "../data/defaults.js";
import { sanitizeContextCursorsByRoom, sanitizeContextDeliverySequences, sanitizePendingContextCursorsByRoom } from "./contextCursors.js";
import { mergeApprovalCommands, reconcileApprovalState } from "./approvalLifecycle.js";
import { isSubagentThreadSource } from "./internalThreads.js";

export const STATE_SCHEMA_VERSION = 8;

const LEGACY_DEMO_MESSAGE_IDS = new Set(["m1", "m2", "m3", "m4", "m5", "m6", "day"]);
const LEGACY_DEMO_KNOWLEDGE_IDS = new Set(["knowledge-1", "knowledge-2", "knowledge-3"]);

export function isCorruptedThreadTitle(value) {
  const compact = String(value ?? "").replace(/\s/g, "");
  return compact.length >= 2 && /^\?+$/.test(compact);
}

export function sanitizeThreadCache(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).map(([roomId, threads]) => [
    roomId,
    Array.isArray(threads)
      ? threads.filter((thread) => thread?.kind !== "demo" && !isCorruptedThreadTitle(thread?.title) && !isSubagentThreadSource(thread?.source))
      : [],
  ]));
}

function legacyTransportMessage(value) {
  const match = String(value || "").match(/^(runtime|remote)-message-(\d+)$/);
  return match ? { source: match[1], sequence: match[2] } : null;
}

export function sanitizeRoomMessages(value) {
  const result = [];
  const ids = new Set();
  const legacyByFingerprint = new Map();

  for (const message of Array.isArray(value) ? value : []) {
    if (!message || typeof message !== "object") continue;
    const id = String(message.id || "").slice(0, 200);
    if (id && ids.has(id)) continue;

    const transport = message.kind === "agent" ? legacyTransportMessage(id) : null;
    if (transport) {
      const fingerprint = [
        transport.sequence,
        String(message.agentId || ""),
        String(message.threadId || ""),
        String(message.text || ""),
      ].join("\u0000");
      const previous = legacyByFingerprint.get(fingerprint);
      if (previous && previous.source !== transport.source) {
        if (transport.source === "remote") {
          const kept = result[previous.index];
          ids.delete(String(kept?.id || ""));
          result[previous.index] = { ...message, time: kept?.time || message.time };
          if (id) ids.add(id);
          legacyByFingerprint.set(fingerprint, { source: transport.source, index: previous.index });
        }
        continue;
      }
      legacyByFingerprint.set(fingerprint, { source: transport.source, index: result.length });
    }

    result.push(message);
    if (id) ids.add(id);
  }

  return result;
}

export function sanitizeHistoryCache(value) {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value).slice(-30);
  return Object.fromEntries(entries.flatMap(([threadId, cached]) => {
    if (!cached?.thread || !Array.isArray(cached.messages)) return [];
    const safeThreadId = String(threadId || cached.thread.id || "").slice(0, 200);
    if (!safeThreadId) return [];
    let remainingText = 240_000;
    const messages = cached.messages.slice(-200).map((message) => {
      const text = String(message?.text || "").slice(0, Math.min(8_000, remainingText));
      remainingText -= text.length;
      return {
        id: String(message?.id || crypto.randomUUID()).slice(0, 200),
        role: message?.role === "user" ? "user" : "assistant",
        text,
      };
    }).filter((message) => message.text);
    return [[safeThreadId, {
      thread: { ...cached.thread, id: safeThreadId, title: String(cached.thread.title || "未命名对话").slice(0, 500) },
      messages,
      roomId: String(cached.roomId || "").slice(0, 160),
      cachedAt: String(cached.cachedAt || ""),
    }]];
  }));
}

export function createSafeMemberPrompt({ name = "成员", role = "项目协作者" } = {}) {
  const memberName = String(name).trim() || "成员";
  const memberRole = String(role).trim() || "项目协作者";
  if (memberName === "总控" || memberRole.includes("总控") || memberRole === "项目经理") {
    return `你是“${memberName}”，在当前项目中担任纯协调者。只负责澄清目标、分析、拆解、规划、委派和汇总；严禁亲自调用命令、读取项目文件、修改文件或执行其他本机操作，需要证据时必须委派资料、开发或审核成员。你会收到 TEAM_ROOM_SHARED_CONTEXT_V1 的当前项目知识和团队消息，区分用户原话、成员输出及来源对话。只有严格的 TEAM_ROOM_TASK_ASSIGNMENT_V1 块才算真实委派，不要以承诺或普通 @文字代替委派。运行时权限边界高于本提示词，不能通过改写提示词解除。`;
  }
  return `你是“${memberName}”，在当前项目中担任${memberRole}。只处理当前项目和本轮任务相关的信息；不确定时先说明依据与风险。你会收到标记为 TEAM_ROOM_SHARED_CONTEXT_V1 的当前项目公共知识和近期团队消息；区分用户原话、其他成员输出及其来源对话，不把成员意见冒充用户决定。只有任务与你的职责相关或用户直接点名时才给出实质回复，否则简短说明保持静默。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。任何写入、外部操作或高影响建议都必须先说明影响并遵守用户的审批要求。`;
}

function copyAgent(agent) {
  const { runtimeThreadId, ...persistentAgent } = agent || {};
  const migrated = {
    ...persistentAgent,
    boundThreadId: typeof persistentAgent.boundThreadId === "string" && persistentAgent.boundThreadId.trim()
      ? persistentAgent.boundThreadId.trim()
      : null,
    threadBinding: persistentAgent.threadBinding === "existing" ? "existing" : "auto",
    systemPrompt: typeof persistentAgent.systemPrompt === "string" && persistentAgent.systemPrompt.trim()
      ? persistentAgent.systemPrompt.trim()
      : createSafeMemberPrompt(persistentAgent),
  };
  return migrated;
}

export function createRoomAgents(agents = DEFAULT_AGENTS) {
  return Array.isArray(agents) && agents.length
    ? agents.map(copyAgent)
    : DEFAULT_AGENTS.map(copyAgent);
}

export function createProjectMember({ id, name = "新成员", role = "项目协作者" } = {}) {
  const memberName = String(name).trim() || "新成员";
  const memberRole = String(role).trim() || "项目协作者";
  return {
    id: id || `member-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: memberName,
    role: memberRole,
    description: "负责当前项目中分配给自己的协作任务。",
    model: "gpt-5.6-terra",
    reasoning: "high",
    permission: "read-only",
    participation: "relevant",
    boundThreadId: null,
    threadBinding: "auto",
    systemPrompt: createSafeMemberPrompt({ name: memberName, role: memberRole }),
    status: "active",
    statusLabel: "待命",
    avatar: "/assets/agents/agent-researcher.png",
    color: "blue",
  };
}

export function addRoomMember(agents, member) {
  return [...(Array.isArray(agents) ? agents : []), copyAgent(member)];
}

export function replaceRoomMember(agents, member) {
  return (Array.isArray(agents) ? agents : []).map((agent) => agent.id === member.id ? copyAgent(member) : agent);
}

export function removeRoomMember(agents, memberId) {
  return (Array.isArray(agents) ? agents : []).filter((agent) => agent.id !== memberId);
}

export function migrateTeamRoomState(value) {
  const input = value && typeof value === "object" ? value : {};
  const rooms = (Array.isArray(input.rooms) && input.rooms.length ? input.rooms : [DEFAULT_ROOM]).map((room) => room.id === "team-room-prototype" && room.name === "Team Room 原型" ? { ...room, name: DEFAULT_ROOM.name } : room);
  const legacyAgents = createRoomAgents(input.agents);
  const existingAgentsByRoom = input.agentsByRoom && typeof input.agentsByRoom === "object"
    ? input.agentsByRoom
    : {};
  const existingLocks = input.writeLocksByRoom && typeof input.writeLocksByRoom === "object"
    ? input.writeLocksByRoom
    : {};
  const activeRoomId = rooms.some((room) => room.id === input.activeRoomId)
    ? input.activeRoomId
    : rooms[0].id;

  const agentsByRoom = {};
  const writeLocksByRoom = {};
  for (const room of rooms) {
    agentsByRoom[room.id] = createRoomAgents(existingAgentsByRoom[room.id] || legacyAgents);
    // A previous global lock was only browser-local state. Keep it within the
    // previously active room, never let it block or authorize another project.
    writeLocksByRoom[room.id] = existingLocks[room.id] || (room.id === activeRoomId ? input.writeLock || null : null);
  }

  const { agents, writeLock, ...rest } = input;
  const migrated = {
    ...rest,
    schemaVersion: STATE_SCHEMA_VERSION,
    rooms,
    activeRoomId,
    agentsByRoom,
    writeLocksByRoom,
    threadCache: sanitizeThreadCache(input.threadCache),
    historyCacheByThread: sanitizeHistoryCache(input.historyCacheByThread),
    contextCursorsByRoom: sanitizeContextCursorsByRoom(input.contextCursorsByRoom),
    contextDeliverySequenceByRoom: sanitizeContextDeliverySequences(input.contextDeliverySequenceByRoom),
    pendingContextCursorsByRoom: sanitizePendingContextCursorsByRoom(input.pendingContextCursorsByRoom),
    messagesByRoom: Object.fromEntries(Object.entries(input.messagesByRoom || {}).map(([roomId, messages]) => [roomId, sanitizeRoomMessages((Array.isArray(messages) ? messages : []).filter((message) => !LEGACY_DEMO_MESSAGE_IDS.has(message?.id)))])),
    commandsByRoom: Object.fromEntries(rooms.map((room) => [room.id, mergeApprovalCommands(
      (Array.isArray(input.commandsByRoom?.[room.id]) ? input.commandsByRoom[room.id] : []).filter((command) => command?.id !== "command-1"),
      [],
      { roomId: room.id, agentPermissionsById: Object.fromEntries((agentsByRoom[room.id] || []).map((agent) => [agent.id, agent.permission])) },
    )])),
    knowledgeByRoom: Object.fromEntries(Object.entries(input.knowledgeByRoom || {}).map(([roomId, entries]) => [roomId, (Array.isArray(entries) ? entries : []).filter((entry) => !LEGACY_DEMO_KNOWLEDGE_IDS.has(entry?.id))])),
  };
  return reconcileApprovalState(migrated, { privateCloud: false, runtimeConnected: null });
}
