const TERMINAL_FAILURE_STATUSES = new Set(["cancelled", "canceled", "failed", "interrupted"]);

function text(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function eventType(event) {
  return text(event?.type || event?.event_type, 80);
}

function roomIdOf(event) {
  return text(event?.roomId || event?.room_id, 160);
}

function taskIdOf(event) {
  return text(event?.taskId || event?.task_id, 200);
}

function assignmentLabel(phase, active) {
  if (phase === "analysis") return active ? "正在参与方案讨论" : "讨论结论已回流";
  if (phase === "execution") return active ? "正在执行总控裁决后的任务" : "执行结果已回流";
  if (["received", "assigned", "delegated"].includes(phase)) return "已收到总控委派";
  if (["reporting", "result_return", "resultreturn"].includes(phase)) return active ? "正在回传委派结果" : "委派结果已回传";
  if (["summarizing", "final_summary", "finalsummary"].includes(phase)) return active ? "正在汇总成员结果" : "成员结果已汇总";
  if (["working", "executing"].includes(phase)) return "正在执行总控委派";
  return null;
}

function startedLabel(turnKind, assignmentPhase, agentId) {
  const phaseLabel = assignmentLabel(assignmentPhase, true);
  if (phaseLabel) return phaseLabel;
  if (turnKind === "delegatedTarget") return "已收到总控委派";
  if (turnKind === "finalSummary") return "已收到成员结果，准备汇总";
  if (turnKind === "resultReturn") return "已收到成员结果";
  if (agentId === "coordinator") return "已收到，正在分析与拆解";
  return "已收到";
}

function progressLabel(turnKind, assignmentPhase, stage, agentId) {
  const phaseLabel = assignmentLabel(assignmentPhase, true);
  if (phaseLabel) return phaseLabel;
  if (stage === "delivered") return startedLabel(turnKind, assignmentPhase, agentId);
  if (turnKind === "finalSummary") return "正在汇总成员结果";
  if (turnKind === "resultReturn") return "正在接收成员结果";
  if (turnKind === "delegatedTarget") return "正在执行总控委派";
  if (agentId === "coordinator") return "正在分析与拆解";
  return "正在执行";
}

function withoutRoomAgent(state, roomId, agentId) {
  const room = state[roomId];
  if (!room || !Object.hasOwn(room, agentId)) return state;
  const nextRoom = { ...room };
  delete nextRoom[agentId];
  const next = { ...state };
  if (Object.keys(nextRoom).length) next[roomId] = nextRoom;
  else delete next[roomId];
  return next;
}

/**
 * Reduces real Team Room runtime events into transient member-card activity.
 * The returned state is shaped as { [roomId]: { [agentId]: activity } } and
 * should not be persisted with room/member configuration.
 */
export function reduceAgentActivity(state = {}, event = {}) {
  const current = state && typeof state === "object" ? state : {};
  const type = eventType(event);
  const roomId = roomIdOf(event);

  if (type === "runtimeDisconnected") {
    if (!roomId || !Object.hasOwn(current, roomId)) return current;
    const next = { ...current };
    delete next[roomId];
    return next;
  }

  if (["taskCompleted", "taskFailed"].includes(type)) {
    const taskId = taskIdOf(event);
    if (!roomId || !taskId || !current[roomId]) return current;
    let next = current;
    for (const [agentId, activity] of Object.entries(current[roomId])) {
      if (activity?.taskId === taskId) next = withoutRoomAgent(next, roomId, agentId);
    }
    return next;
  }

  const agentId = text(event.agentId || event.agent_id, 160);
  const turnId = text(event.turnId || event.turn_id, 200);
  if (!roomId || !agentId || !turnId) return current;
  const taskId = taskIdOf(event) || null;
  const turnKind = text(event.turnKind || event.turn_kind, 80) || "initial";
  const assignmentPhase = text(event.assignmentPhase || event.assignment_phase, 80).toLowerCase() || null;
  const room = current[roomId] || {};
  const activity = room[agentId] || null;

  if (type === "turnStarted") {
    return {
      ...current,
      [roomId]: {
        ...room,
        [agentId]: {
          active: true,
          status: "received",
          label: startedLabel(turnKind, assignmentPhase, agentId),
          taskId,
          turnId,
          turnKind,
          assignmentId: text(event.assignmentId || event.assignment_id, 160) || null,
          assignmentPhase,
        },
      },
    };
  }

  if (!activity || activity.turnId !== turnId) return current;

  if (type === "turnProgress") {
    const stage = text(event.stage, 80) || "working";
    return {
      ...current,
      [roomId]: {
        ...room,
        [agentId]: {
          ...activity,
          active: true,
          status: stage === "delivered" ? "received" : "working",
          label: progressLabel(activity.turnKind, assignmentPhase || activity.assignmentPhase, stage, agentId),
          assignmentPhase: assignmentPhase || activity.assignmentPhase,
          stage,
        },
      },
    };
  }

  if (type === "turnCompleted") {
    const terminalStatus = text(event.status || event.turn?.status, 80).toLowerCase();
    const failed = TERMINAL_FAILURE_STATUSES.has(terminalStatus);
    return {
      ...current,
      [roomId]: {
        ...room,
        [agentId]: {
          ...activity,
          active: false,
          status: failed ? "failed" : "completed",
          label: failed ? "本轮失败" : "本轮已完成",
          terminalStatus: terminalStatus || "completed",
        },
      },
    };
  }

  return current;
}
