import { DEFAULT_AGENTS, DEFAULT_ROOM } from "../data/defaults.js";

export const STATE_SCHEMA_VERSION = 2;

export function createSafeMemberPrompt({ name = "成员", role = "项目协作者" } = {}) {
  const memberName = String(name).trim() || "成员";
  const memberRole = String(role).trim() || "项目协作者";
  return `你是“${memberName}”，在当前项目中担任${memberRole}。只处理当前项目和本轮任务相关的信息；不确定时先说明依据与风险。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。任何写入、外部操作或高影响建议都必须先说明影响并遵守用户的审批要求。`;
}

function copyAgent(agent) {
  const { runtimeThreadId, ...persistentAgent } = agent || {};
  return {
    ...persistentAgent,
    boundThreadId: typeof persistentAgent.boundThreadId === "string" && persistentAgent.boundThreadId.trim()
      ? persistentAgent.boundThreadId.trim()
      : null,
    threadBinding: persistentAgent.threadBinding === "existing" ? "existing" : "auto",
    systemPrompt: typeof persistentAgent.systemPrompt === "string" && persistentAgent.systemPrompt.trim()
      ? persistentAgent.systemPrompt.trim()
      : createSafeMemberPrompt(persistentAgent),
  };
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
  const rooms = Array.isArray(input.rooms) && input.rooms.length ? input.rooms : [DEFAULT_ROOM];
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
  return {
    ...rest,
    schemaVersion: STATE_SCHEMA_VERSION,
    rooms,
    activeRoomId,
    agentsByRoom,
    writeLocksByRoom,
  };
}
