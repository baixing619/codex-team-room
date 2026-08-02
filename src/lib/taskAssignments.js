export const TASK_ASSIGNMENT_START = "[TEAM_ROOM_TASK_ASSIGNMENT_V1]";
export const TASK_ASSIGNMENT_END = "[/TEAM_ROOM_TASK_ASSIGNMENT_V1]";
export const TASK_RESULT_START = "[TEAM_ROOM_TASK_RESULT_V1]";
export const TASK_RESULT_END = "[/TEAM_ROOM_TASK_RESULT_V1]";
export const MAX_ASSIGNMENT_DEPTH = 2;
export const MAX_ASSIGNMENTS_PER_TASK = 4;

const ASSIGNMENT_FIELDS = new Set([
  "assignmentId",
  "parentTaskId",
  "targetAgentId",
  "objective",
  "acceptanceCriteria",
  "visibility",
  "depth",
]);
const VISIBILITIES = new Set(["coordinator-only", "room"]);

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function requiredText(value, max = 4000) {
  const result = text(value, max);
  return result || null;
}

function criteria(value) {
  if (Array.isArray(value)) return value.map((item) => text(item, 1000)).filter(Boolean).slice(0, 20);
  const single = text(value, 4000);
  return single ? [single] : [];
}

function normalizeAssignment(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => !ASSIGNMENT_FIELDS.has(key))) return null;
  const depth = Number(raw.depth);
  const visibility = text(raw.visibility, 40) || "room";
  const assignment = {
    assignmentId: requiredText(raw.assignmentId, 160),
    parentTaskId: requiredText(raw.parentTaskId, 160),
    targetAgentId: requiredText(raw.targetAgentId, 160),
    objective: requiredText(raw.objective, 8000),
    acceptanceCriteria: criteria(raw.acceptanceCriteria),
    visibility: VISIBILITIES.has(visibility) ? visibility : null,
    depth: Number.isInteger(depth) ? depth : null,
  };
  if (!assignment.assignmentId || !assignment.parentTaskId || !assignment.targetAgentId || !assignment.objective
    || !assignment.acceptanceCriteria.length || !assignment.visibility || assignment.depth === null) return null;
  return assignment;
}

function extractJsonBlock(value, start, end) {
  const source = String(value ?? "");
  const first = source.indexOf(start);
  if (first < 0) return null;
  const second = source.indexOf(start, first + start.length);
  const closing = source.indexOf(end, first + start.length);
  if (second >= 0 && (closing < 0 || second < closing)) return null;
  if (closing < 0) return null;
  const body = source.slice(first + start.length, closing).trim();
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseTaskAssignment(value) {
  return parseTaskAssignments(value)[0] || null;
}

export function parseTaskAssignments(value) {
  const source = String(value ?? "");
  const assignments = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(TASK_ASSIGNMENT_START, cursor);
    if (start < 0) break;
    const nextStart = source.indexOf(TASK_ASSIGNMENT_START, start + TASK_ASSIGNMENT_START.length);
    const end = source.indexOf(TASK_ASSIGNMENT_END, start + TASK_ASSIGNMENT_START.length);
    if (end < 0 || (nextStart >= 0 && nextStart < end)) return [];
    const body = source.slice(start + TASK_ASSIGNMENT_START.length, end).trim();
    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      return [];
    }
    const assignment = normalizeAssignment(raw);
    if (!assignment || assignments.some((item) => item.assignmentId === assignment.assignmentId)) return [];
    assignments.push(assignment);
    if (assignments.length > MAX_ASSIGNMENTS_PER_TASK) return [];
    cursor = end + TASK_ASSIGNMENT_END.length;
  }
  return assignments;
}

export function formatTaskAssignment(value) {
  const assignment = parseTaskAssignment(`${TASK_ASSIGNMENT_START}${JSON.stringify(value)}${TASK_ASSIGNMENT_END}`);
  if (!assignment) throw new Error("invalid_task_assignment");
  return `${TASK_ASSIGNMENT_START}\n${JSON.stringify(assignment)}\n${TASK_ASSIGNMENT_END}`;
}

export function formatTaskResult({ assignmentId, parentTaskId, targetAgentId, sourceTurnId, status, summary, acceptanceCriteria = [] } = {}) {
  const safeStatus = status === "succeeded" ? "succeeded" : "failed";
  const safeSummary = sanitizeTaskText(summary, 8000) || (safeStatus === "succeeded" ? "目标成员未提供摘要" : "目标成员任务失败");
  const body = {
    assignmentId: text(assignmentId, 160),
    parentTaskId: text(parentTaskId, 160),
    targetAgentId: text(targetAgentId, 160),
    sourceTurnId: text(sourceTurnId, 200),
    status: safeStatus,
    summary: safeSummary,
    acceptanceCriteria: criteria(acceptanceCriteria),
  };
  return `${TASK_RESULT_START}\n${JSON.stringify(body)}\n${TASK_RESULT_END}`;
}

export function parseTaskResult(value) {
  const raw = extractJsonBlock(value, TASK_RESULT_START, TASK_RESULT_END);
  if (!raw) return null;
  const status = raw.status === "succeeded" ? "succeeded" : raw.status === "failed" ? "failed" : null;
  if (!status) return null;
  return {
    assignmentId: requiredText(raw.assignmentId, 160),
    parentTaskId: requiredText(raw.parentTaskId, 160),
    targetAgentId: requiredText(raw.targetAgentId, 160),
    sourceTurnId: requiredText(raw.sourceTurnId, 200),
    status,
    summary: sanitizeTaskText(raw.summary, 8000),
    acceptanceCriteria: criteria(raw.acceptanceCriteria),
  };
}

export function sanitizeTaskText(value, max = 8000) {
  return text(value, max)
    .replace(/[A-Za-z]:[\\/][^\s\]\)\}>,;]+/g, "[本机路径已隐藏]")
    .replace(/(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]+/gi, "[凭据已隐藏]")
    .replace(/(?:^|\n)\s*(?:PS [^>]+>|\$\s+|>\s+)/g, "$1[命令输出已隐藏] ");
}

export function stripTaskAssignmentBlocks(value) {
  const source = String(value ?? "");
  let output = "";
  let cursor = 0;
  while (true) {
    const start = source.indexOf(TASK_ASSIGNMENT_START, cursor);
    if (start < 0) {
      output += source.slice(cursor);
      break;
    }
    output += source.slice(cursor, start);
    const end = source.indexOf(TASK_ASSIGNMENT_END, start + TASK_ASSIGNMENT_START.length);
    if (end < 0) break;
    cursor = end + TASK_ASSIGNMENT_END.length;
  }
  return output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function isCoordinatorOnlyRequest(value) {
  const source = text(value, 20_000);
  return /(其他人|其他成员).{0,12}(不要|无需|不用).{0,8}(发言|回复)|只让总控|仅总控|总控回复|coordinator[- ]only/i.test(source);
}

export function validateTaskAssignment({ assignment, coordinatorAgentId, sourceRoomId, sourceTurnId, sourceThreadId, parentTask, agents = [], assignmentsById = new Map(), sourceTargets = new Set() } = {}) {
  if (!assignment || !parentTask) return { ok: false, reason: "assignment_parent_not_found" };
  if (sourceRoomId !== parentTask.roomId || sourceTurnId !== parentTask.coordinatorTurnId || sourceThreadId !== parentTask.coordinatorThreadId) {
    return { ok: false, reason: "assignment_source_not_coordinator_turn" };
  }
  if (assignment.parentTaskId !== parentTask.id) return { ok: false, reason: "assignment_parent_mismatch" };
  if (assignment.depth < 1 || assignment.depth > MAX_ASSIGNMENT_DEPTH || assignment.depth !== parentTask.depth + 1) {
    return { ok: false, reason: "assignment_depth_invalid" };
  }
  if (assignmentsById.has(assignment.assignmentId)) return { ok: false, reason: "assignment_duplicate", duplicate: true };
  if (sourceTargets.has(`${sourceTurnId}:${assignment.targetAgentId}`)) return { ok: false, reason: "assignment_source_target_duplicate" };
  if (parentTask.delegationCount >= MAX_ASSIGNMENTS_PER_TASK) return { ok: false, reason: "assignment_limit_reached" };
  const target = agents.find((agent) => agent.id === assignment.targetAgentId);
  if (!target) return { ok: false, reason: "assignment_target_not_found" };
  if (target.id === coordinatorAgentId || target.id === parentTask.coordinatorAgentId) return { ok: false, reason: "assignment_self_target" };
  if (parentTask.agentPath?.includes(target.id)) return { ok: false, reason: "assignment_cycle" };
  return { ok: true, target };
}
