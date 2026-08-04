const ACTIVE_STATUSES = new Set(["pending", "submitted", "approved"]);
const TERMINAL_STATUSES = new Set(["completed", "denied", "failed", "expired", "cancelled", "interrupted"]);

const STATUS_RANK = {
  pending: 10,
  submitted: 20,
  approved: 30,
  completed: 40,
  denied: 40,
  failed: 40,
  expired: 40,
  cancelled: 40,
  interrupted: 40,
};

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizedId(value) {
  const result = text(value, 200);
  return result || null;
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return result.toString(16).padStart(8, "0");
}

function methodName(value) {
  return text(value, 160);
}

function permissionName(value) {
  return text(value, 80);
}

export function isApprovalActive(status) {
  return ACTIVE_STATUSES.has(status);
}

export function isApprovalTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

export function visibleApprovalCommands(commands) {
  return (Array.isArray(commands) ? commands : []).filter((command) => isApprovalActive(command?.status));
}

export function normalizeApprovalRequestId(value) {
  const result = text(value, 160);
  return result || null;
}

/**
 * Approval safety is based on the protocol method and the sandbox permission
 * selected for the member. Command text is deliberately not inspected.
 */
export function classifyApprovalRequest({ method, agentPermission } = {}) {
  const normalizedMethod = methodName(method);
  const permission = permissionName(agentPermission);
  const coordinatorSandbox = permission === "coordinate";
  const readOnlySandbox = permission === "read-only";
  const writeSandbox = permission === "request-write";

  if (coordinatorSandbox && (normalizedMethod === "item/commandExecution/requestApproval" || normalizedMethod === "item/fileChange/requestApproval")) {
    return {
      kind: "coordinator-blocked",
      operationType: "总控不得执行本机操作",
      impact: "总控只能分析、规划、委派和汇总",
      risk: "高",
      requiresWriteLock: false,
      canAccept: false,
    };
  }

  if (normalizedMethod === "item/commandExecution/requestApproval" && readOnlySandbox) {
    return {
      kind: "read-only",
      operationType: "只读命令",
      impact: "只读读取",
      risk: "低",
      requiresWriteLock: false,
      canAccept: true,
    };
  }

  if ((normalizedMethod === "item/commandExecution/requestApproval" || normalizedMethod === "item/fileChange/requestApproval") && writeSandbox) {
    return {
      kind: "write",
      operationType: "项目写入",
      impact: "可能写入项目",
      risk: "中",
      requiresWriteLock: true,
      canAccept: true,
    };
  }

  return {
    kind: "blocked",
    operationType: "未识别操作",
    impact: "未知影响，默认拒绝",
    risk: "高",
    requiresWriteLock: false,
    canAccept: false,
  };
}

function identityParts(value = {}, roomId = null) {
  const method = methodName(value.approvalMethod || value.method);
  const threadId = normalizedId(value.threadId);
  const turnId = normalizedId(value.turnId);
  const itemId = normalizedId(value.itemId);
  const requestId = normalizeApprovalRequestId(value.runtimeRequestId ?? value.requestId);
  const agentId = normalizedId(value.agentId);
  const cwd = text(value.cwd || value.target, 1000).toLowerCase();
  const command = text(value.command || value.reason, 4000);
  const room = normalizedId(roomId || value.roomId);
  // The same request is represented by different transports: the local
  // runtime carries cwd while the remote bridge carries a project label.
  // Neither is part of the protocol identity, so excluding it prevents a
  // runtime/remote duplicate card for one real approval.
  const coarse = JSON.stringify([room, agentId, requestId, command]);
  const strong = JSON.stringify([room, agentId, requestId, method, threadId, turnId, itemId, command]);
  const rich = Boolean(method || threadId || turnId || itemId);
  return {
    key: `approval:${hash(strong)}`,
    coarseKey: `approval-coarse:${hash(coarse)}`,
    rich,
    method,
    threadId,
    turnId,
    itemId,
    requestId,
    agentId,
    cwd,
    command,
    room,
  };
}

export function approvalIdentity(value, roomId = null) {
  return identityParts(value, roomId);
}

function sameApproval(left, right, roomId) {
  const a = identityParts(left, roomId);
  const b = identityParts(right, roomId);
  if (a.key === b.key) return true;
  // Older persisted cards did not carry method/thread/item metadata. Allow a
  // coarse match only when at least one side is legacy; two rich requests with
  // a reused numeric request id must remain separate.
  return (!a.rich || !b.rich) && a.coarseKey === b.coarseKey;
}

function statusFor(command) {
  return STATUS_RANK[command?.status] ? command.status : "pending";
}

function chooseStatus(left, right) {
  const a = statusFor(left);
  const b = statusFor(right);
  if (left?.legacyLifecycle && !right?.legacyLifecycle) return b;
  if (right?.legacyLifecycle && !left?.legacyLifecycle) return a;
  if ((STATUS_RANK[b] || 0) > (STATUS_RANK[a] || 0)) return b;
  return a;
}

function normalizeOriginSources(command) {
  const values = [
    ...(Array.isArray(command?.originSources) ? command.originSources : []),
    command?.source,
  ].filter((value) => value === "runtime" || value === "remote");
  return Array.from(new Set(values));
}

export function normalizeApprovalCommand(command, { roomId, agentPermission } = {}) {
  const input = command && typeof command === "object" ? command : {};
  const identity = identityParts(input, roomId);
  const effectivePermission = input.agentPermission || agentPermission || null;
  const classification = classifyApprovalRequest({
    method: identity.method,
    agentPermission: effectivePermission,
  });
  const legacyLifecycle = input.legacyLifecycle !== undefined
    ? Boolean(input.legacyLifecycle)
    : input.lifecycleVersion !== 1;
  const source = input.source === "remote" ? "remote" : input.source === "runtime" ? "runtime" : null;
  return {
    ...input,
    id: input.id || `approval-${identity.key.slice("approval:".length)}`,
    source,
    originSources: normalizeOriginSources(input),
    approvalKey: identity.key,
    approvalCoarseKey: identity.coarseKey,
    approvalMethod: identity.method || null,
    agentPermission: effectivePermission,
    runtimeRequestId: input.runtimeRequestId ?? identity.requestId,
    threadId: input.threadId || identity.threadId,
    turnId: input.turnId || identity.turnId,
    itemId: input.itemId || identity.itemId,
    cwd: input.cwd || null,
    lifecycleVersion: 1,
    legacyLifecycle,
    // Never let a persisted/cloud field grant more access than the member's
    // configured sandbox permission and protocol method allow.
    requiresWriteLock: classification.requiresWriteLock,
    canAccept: classification.canAccept,
    operationType: classification.operationType,
    impact: classification.impact,
    risk: classification.risk,
    status: statusFor(input),
  };
}

export function createApprovalCommand({ source, roomId, event, agent } = {}) {
  const payload = event && typeof event === "object" ? event : {};
  const identity = identityParts({
    roomId,
    agentId: payload.agentId,
    requestId: payload.requestId,
    approvalMethod: payload.method,
    threadId: payload.threadId,
    turnId: payload.turnId,
    itemId: payload.itemId,
    command: payload.command || payload.reason,
    cwd: payload.cwd || payload.target,
  }, roomId);
  const classification = classifyApprovalRequest({ method: identity.method, agentPermission: agent?.permission });
  return normalizeApprovalCommand({
    id: `approval-${identity.key.slice("approval:".length)}`,
    source: source === "remote" ? "remote" : "runtime",
    runtimeRequestId: payload.requestId,
    roomId: payload.roomId || roomId || null,
    taskId: payload.taskId || null,
    agentId: payload.agentId,
    approvalMethod: payload.method,
    threadId: payload.threadId,
    turnId: payload.turnId,
    itemId: payload.itemId,
    cwd: payload.cwd || payload.target || null,
    command: payload.command || payload.reason || "Codex 请求受控操作",
    title: "Codex 请求受控操作",
    summary: source === "remote" ? "来自已配对电脑的真实 Codex，等待一次性审批。" : "来自真实 App Server 线程，等待一次性审批。",
    target: payload.target || payload.cwd || "当前项目",
    agentPermission: agent?.permission || null,
    impact: classification.impact,
    risk: classification.risk,
    operationType: classification.operationType,
    requiresWriteLock: classification.requiresWriteLock,
    canAccept: classification.canAccept,
    status: "pending",
    time: payload.createdAt ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(payload.createdAt)) : undefined,
    receivedAt: payload.createdAt || new Date().toISOString(),
  }, { roomId, agentPermission: agent?.permission });
}

function mergeCommand(left, right, roomId, agentPermissionsById) {
  const status = chooseStatus(left, right);
  const merged = {
    ...left,
    ...right,
    id: right.source === "remote" ? right.id : left.id || right.id,
    status,
    originSources: Array.from(new Set([...normalizeOriginSources(left), ...normalizeOriginSources(right)])),
    updatedAt: right.updatedAt || left.updatedAt,
    legacyLifecycle: Boolean(left.legacyLifecycle && right.legacyLifecycle),
  };
  return normalizeApprovalCommand(merged, { roomId, agentPermission: agentPermissionsById?.[merged.agentId] });
}

export function mergeApprovalCommands(existing, incoming, { roomId, agentPermissionsById } = {}) {
  const result = [];
  for (const raw of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const command = normalizeApprovalCommand(raw, { roomId, agentPermission: agentPermissionsById?.[raw?.agentId] });
    const index = result.findIndex((item) => sameApproval(item, command, roomId));
    if (index < 0) result.push(command);
    else result[index] = mergeCommand(result[index], command, roomId, agentPermissionsById);
  }
  return result;
}

function matchingIndex(commands, event, roomId) {
  return commands.findIndex((command) => sameApproval(command, event, roomId)
    || (normalizeApprovalRequestId(command.runtimeRequestId) !== null
      && normalizeApprovalRequestId(command.runtimeRequestId) === normalizeApprovalRequestId(event.requestId)
      && (!event.agentId || command.agentId === event.agentId)));
}

function commandIsOwnedBySource(command, source) {
  return command.source === source || command.originSources?.includes(source);
}

function patchCommand(commands, event, roomId, patch) {
  const index = matchingIndex(commands, event, roomId);
  if (index < 0) return commands;
  const next = commands.slice();
  next[index] = normalizeApprovalCommand({ ...next[index], ...patch, legacyLifecycle: false }, { roomId });
  return next;
}

function lockMatchesCommand(lock, command) {
  if (!lock || !command) return false;
  return (lock.approvalKey && lock.approvalKey === command.approvalKey)
    || (lock.commandId && lock.commandId === command.id)
    || (lock.agentId && lock.agentId === command.agentId && command.requiresWriteLock);
}

export function applyApprovalLifecycleEvent(state, { roomId, source, event } = {}) {
  if (!state || !roomId || !event) return state;
  const commands = state.commandsByRoom?.[roomId] || [];
  const agents = state.agentsByRoom?.[roomId] || [];
  const agent = agents.find((item) => item.id === event.agentId) || null;
  const agentPermissionsById = Object.fromEntries(agents.map((item) => [item.id, item.permission]));
  const eventType = event.type || event.event_type;
  const normalizedSource = source === "remote" ? "remote" : "runtime";
  let nextCommands = commands;
  let nextLock = state.writeLocksByRoom?.[roomId] || null;

  if (eventType === "approvalRequested") {
    nextCommands = mergeApprovalCommands(commands, [createApprovalCommand({ source: normalizedSource, roomId, event, agent })], { roomId, agentPermissionsById });
  } else if (eventType === "approvalResolved") {
    const decision = event.decision === "accept" ? "approved" : event.decision === "cancel" ? "cancelled" : "denied";
    nextCommands = patchCommand(commands, event, roomId, { status: decision, resolvedAt: event.createdAt || new Date().toISOString(), submittedDecision: event.decision });
    const matched = nextCommands[matchingIndex(nextCommands, event, roomId)];
    if (decision === "approved" && matched?.requiresWriteLock) {
      nextLock = {
        agentId: matched.agentId,
        commandId: matched.id,
        approvalKey: matched.approvalKey,
        threadId: matched.threadId || null,
        acquiredAt: event.createdAt || new Date().toISOString(),
        requiresWriteLock: true,
      };
    } else if (lockMatchesCommand(nextLock, matched || commands[matchingIndex(commands, event, roomId)])) {
      nextLock = null;
    }
  } else if (eventType === "approvalFailed") {
    nextCommands = patchCommand(commands, event, roomId, { status: "failed", error: text(event.error || event.reason, 1000), failedAt: event.createdAt || new Date().toISOString() });
    const matched = commands[matchingIndex(commands, event, roomId)];
    if (lockMatchesCommand(nextLock, matched)) nextLock = null;
  } else if (eventType === "writeItemCompleted") {
    const candidates = commands.filter((command) => commandIsOwnedBySource(command, normalizedSource) && command.agentId === event.agentId && command.status === "approved");
    const matched = candidates.find((command) => !event.itemId || command.itemId === event.itemId) || candidates[0];
    if (matched) {
      const itemStatus = text(event.item?.status || event.status, 80).toLowerCase();
      nextCommands = patchCommand(commands, matched, roomId, { status: itemStatus === "completed" ? "completed" : "failed", completedAt: event.createdAt || new Date().toISOString() });
      if (lockMatchesCommand(nextLock, matched)) nextLock = null;
    }
  } else if (eventType === "turnCompleted") {
    const affected = commands.filter((command) => commandIsOwnedBySource(command, normalizedSource)
      && command.agentId === event.agentId
      && (!event.threadId || command.threadId === event.threadId)
      && isApprovalActive(command.status));
    for (const command of affected) {
      nextCommands = patchCommand(nextCommands, command, roomId, { status: "expired", expiredAt: event.createdAt || new Date().toISOString(), error: event.status || "turn_completed" });
      if (lockMatchesCommand(nextLock, command)) nextLock = null;
    }
  } else if (eventType === "runtimeDisconnected") {
    const affected = commands.filter((command) => commandIsOwnedBySource(command, normalizedSource) && isApprovalActive(command.status));
    for (const command of affected) {
      nextCommands = patchCommand(nextCommands, command, roomId, { status: "expired", expiredAt: event.createdAt || new Date().toISOString(), error: "runtime_disconnected" });
      if (lockMatchesCommand(nextLock, command)) nextLock = null;
    }
  }

  if (nextLock && !nextLock.approvalKey) {
    const locked = nextCommands.find((command) => command.id === nextLock.commandId);
    if (locked) nextLock = { ...nextLock, approvalKey: locked.approvalKey, requiresWriteLock: locked.requiresWriteLock };
  }
  return {
    ...state,
    commandsByRoom: { ...state.commandsByRoom, [roomId]: nextCommands },
    writeLocksByRoom: { ...state.writeLocksByRoom, [roomId]: nextLock },
  };
}

export function reconcileApprovalState(state, { privateCloud = false, runtimeConnected = null } = {}) {
  if (!state || !Array.isArray(state.rooms)) return state;
  let changed = false;
  const commandsByRoom = { ...state.commandsByRoom };
  const writeLocksByRoom = { ...state.writeLocksByRoom };
  for (const room of state.rooms) {
    const agents = state.agentsByRoom?.[room.id] || [];
    const agentPermissionsById = Object.fromEntries(agents.map((item) => [item.id, item.permission]));
    let commands = mergeApprovalCommands(commandsByRoom[room.id] || [], [], { roomId: room.id, agentPermissionsById });
    const before = commandsByRoom[room.id] || [];
    const legacyActive = commands.filter((command) => command.legacyLifecycle && isApprovalActive(command.status));
    if (legacyActive.length) {
      const legacyKeys = new Set(legacyActive.map((item) => item.approvalKey));
      // These cards predate the durable lifecycle and cannot be safely
      // resolved. Remove them on migration instead of leaving stale buttons.
      commands = commands.filter((command) => !legacyKeys.has(command.approvalKey));
    }
    if (privateCloud) {
      commands = commands.filter((command) => !(command.source === "runtime" && !command.originSources?.includes("remote")));
    }
    if (runtimeConnected === false) {
      commands = commands.map((command) => commandIsOwnedBySource(command, "runtime") && isApprovalActive(command.status)
        ? { ...command, status: "expired", expiredAt: new Date().toISOString(), error: "runtime_disconnected" }
        : command);
    }
    if (JSON.stringify(before) !== JSON.stringify(commands)) {
      commandsByRoom[room.id] = commands;
      changed = true;
    }
    const lock = writeLocksByRoom[room.id];
    if (lock) {
      const locked = commands.find((command) => lockMatchesCommand(lock, command));
      if (!locked || !locked.requiresWriteLock || locked.status !== "approved") {
        writeLocksByRoom[room.id] = null;
        changed = true;
      } else if (lock.approvalKey !== locked.approvalKey) {
        writeLocksByRoom[room.id] = { ...lock, approvalKey: locked.approvalKey, requiresWriteLock: true };
        changed = true;
      }
    }
  }
  return changed ? { ...state, commandsByRoom, writeLocksByRoom } : state;
}

export function approvalRoute({ privateCloud = false } = {}) {
  return privateCloud ? "remote" : "runtime";
}
