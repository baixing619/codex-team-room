import { migrateTeamRoomState } from "./roomAgents.js";
import { normalizeApprovalCommand } from "./approvalLifecycle.js";

const MAX_ROOMS = 24;
const MAX_MESSAGES_PER_ROOM = 120;
const MAX_COMMANDS_PER_ROOM = 80;
const MAX_KNOWLEDGE_PER_ROOM = 50;

function text(value, max) {
  return String(value || "").slice(0, max);
}

function mapRooms(rooms, source, mapper, limit) {
  return Object.fromEntries(rooms.map((room) => [
    room.id,
    (Array.isArray(source?.[room.id]) ? source[room.id] : []).slice(-limit).map(mapper),
  ]));
}

export function createCloudSnapshot(state) {
  const rooms = (Array.isArray(state?.rooms) ? state.rooms : []).slice(0, MAX_ROOMS).map((room) => ({
    id: text(room.id, 160), name: text(room.name, 300), path: text(room.path, 1000), source: text(room.source, 80), connected: room.connected !== false,
  })).filter((room) => room.id && room.path);
  const roomIds = new Set(rooms.map((room) => room.id));
  const commandsByRoom = Object.fromEntries(rooms.map((room) => [
    room.id,
    (Array.isArray(state.commandsByRoom?.[room.id]) ? state.commandsByRoom[room.id] : [])
      .map((command) => normalizeApprovalCommand(command, {
        roomId: room.id,
        agentPermission: state.agentsByRoom?.[room.id]?.find((agent) => agent.id === command.agentId)?.permission,
      }))
      // Local runtime requests are transported to the paired site as runtime
      // events. Persisting them as actionable cloud cards would let a phone
      // route a local-only approval to a nonexistent local endpoint.
      .filter((command) => command.source !== "runtime" || command.originSources?.includes("remote"))
      .slice(-MAX_COMMANDS_PER_ROOM)
      .map((command) => ({ ...command, command: text(command.command, 4_000), summary: text(command.summary, 2_000) })),
  ]));
  return {
    schemaVersion: Number(state?.schemaVersion) || 8,
    rooms,
    agentsByRoom: Object.fromEntries(rooms.map((room) => [room.id, (state.agentsByRoom?.[room.id] || []).slice(0, 24).map((agent) => ({
      ...agent,
      id: text(agent.id, 160), name: text(agent.name, 200), role: text(agent.role, 300), description: text(agent.description, 1000),
      systemPrompt: text(agent.systemPrompt, 12_000), boundThreadId: agent.boundThreadId ? text(agent.boundThreadId, 200) : null,
    }))])),
    messagesByRoom: mapRooms(rooms, state.messagesByRoom, (message) => ({
      ...message, id: text(message.id, 160), text: text(message.text, 6_000), attachments: (message.attachments || []).slice(0, 4).map(({ id, name, type, size, kind }) => ({ id, name, type, size, ...(kind === "output" ? { kind: "output" } : {}) })),
    }), MAX_MESSAGES_PER_ROOM),
    commandsByRoom,
    knowledgeByRoom: Object.fromEntries(rooms.map((room) => [room.id, (state.knowledgeByRoom?.[room.id] || []).slice(0, MAX_KNOWLEDGE_PER_ROOM).map((entry) => ({
      ...entry, id: text(entry.id, 160), title: text(entry.title, 300), category: text(entry.category, 120), body: text(entry.body, 8_000),
    }))])),
    threadCache: Object.fromEntries(Object.entries(state.threadCache || {}).filter(([roomId]) => roomIds.has(roomId)).map(([roomId, threads]) => [roomId, (threads || []).slice(0, 300).map((thread) => ({ ...thread, id: text(thread.id, 200), title: text(thread.title, 500) }))])),
    contextCursorsByRoom: Object.fromEntries(rooms.map((room) => [room.id, state.contextCursorsByRoom?.[room.id] || {}])),
    contextDeliverySequenceByRoom: Object.fromEntries(rooms.map((room) => [room.id, Number(state.contextDeliverySequenceByRoom?.[room.id]) || 0])),
    pendingContextCursorsByRoom: Object.fromEntries(rooms.map((room) => [room.id, state.pendingContextCursorsByRoom?.[room.id] || []])),
    writeLocksByRoom: Object.fromEntries(rooms.map((room) => {
      const lock = state.writeLocksByRoom?.[room.id] || null;
      const commands = commandsByRoom[room.id] || [];
      const lockedCommand = lock && commands.find((command) => (lock.approvalKey && command.approvalKey === lock.approvalKey) || (lock.commandId && command.id === lock.commandId));
      return [room.id, lockedCommand?.status === "approved" && lockedCommand.requiresWriteLock
        ? { ...lock, approvalKey: lockedCommand.approvalKey, commandId: lockedCommand.id }
        : null];
    })),
  };
}

export function applyCloudSnapshot(current, snapshot) {
  const next = migrateTeamRoomState({ ...current, ...snapshot });
  const activeRoomId = next.rooms.some((room) => room.id === current.activeRoomId) ? current.activeRoomId : next.rooms[0]?.id;
  return { ...next, activeRoomId };
}
