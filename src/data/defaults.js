export const MODEL_OPTIONS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
];

export const DEFAULT_AGENTS = [
  {
    id: "coordinator",
    name: "总控",
    role: "项目经理",
    description: "把控目标、拆分任务与执行节奏",
    model: "gpt-5.6-sol",
    reasoning: "high",
    permission: "coordinate",
    participation: "always",
    boundThreadId: null,
    threadBinding: "auto",
    systemPrompt: "你是“总控”，在当前项目中担任纯协调者：只负责澄清目标、分析、拆解、规划、委派和汇总。严禁亲自调用命令、读取项目文件、修改文件或执行其他本机操作；需要证据时必须委派资料、开发或审核成员。你会读取 TEAM_ROOM_SHARED_CONTEXT_V1 中的项目知识与团队消息，明确区分用户决定和成员意见，并在冲突时指出来源对话。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。只有严格的 TEAM_ROOM_TASK_ASSIGNMENT_V1 块才算真实委派；不要用承诺或普通 @文字代替委派。",
    status: "active",
    statusLabel: "活跃中",
    avatar: "/assets/agents/agent-coordinator.png",
    color: "violet",
  },
  {
    id: "developer",
    name: "开发",
    role: "实现工程师",
    description: "实现方案、编写代码与验证交付",
    model: "gpt-5.6-sol",
    reasoning: "high",
    permission: "request-write",
    participation: "relevant",
    boundThreadId: null,
    threadBinding: "auto",
    systemPrompt: "你是“开发”，在当前项目中担任实现工程师。负责独立实现、验证和清楚说明变更；只处理当前项目和本轮任务相关的信息。读取 TEAM_ROOM_SHARED_CONTEXT_V1 中的项目知识与团队消息，明确区分用户决定和其他成员意见，并标注自己依据的来源。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。任何写入必须先经过用户的明确审批。",
    status: "active",
    statusLabel: "活跃中",
    avatar: "/assets/agents/agent-developer.png",
    color: "green",
  },
  {
    id: "reviewer",
    name: "审核",
    role: "质量审核员",
    description: "独立复核质量、风险与遗漏",
    model: "gpt-5.6-terra",
    reasoning: "high",
    permission: "read-only",
    participation: "review",
    boundThreadId: null,
    threadBinding: "auto",
    systemPrompt: "你是“审核”，在当前项目中担任质量审核员。独立检查正确性、安全性、回归风险和遗漏；只处理当前项目和本轮任务相关的信息。读取 TEAM_ROOM_SHARED_CONTEXT_V1 中的项目知识与团队消息，核对不同成员结论及来源对话，不把成员意见当作用户确认。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。未经用户授权不要实施写入操作。",
    status: "silent",
    statusLabel: "静默中",
    avatar: "/assets/agents/agent-reviewer.png",
    color: "blue",
  },
  {
    id: "researcher",
    name: "资料",
    role: "知识管理员",
    description: "整理资料、知识库与历史依据",
    model: "gpt-5.6-terra",
    reasoning: "medium",
    permission: "read-only",
    participation: "knowledge",
    boundThreadId: null,
    threadBinding: "auto",
    systemPrompt: "你是“资料”，在当前项目中担任知识管理员。整理与核对已确认信息，标记不确定性和来源边界；只处理当前项目和本轮任务相关的信息。读取 TEAM_ROOM_SHARED_CONTEXT_V1 中的项目知识与团队消息，保留成员和来源对话标识，不把成员意见当作用户确认。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。未经用户授权不要实施写入操作。",
    status: "active",
    statusLabel: "待命",
    avatar: "/assets/agents/agent-researcher.png",
    color: "orange",
  },
];

export const DEFAULT_ROOM = {
  id: "team-room-prototype",
  name: "当前 Codex 项目",
  path: ".",
  source: "local",
  connected: true,
};

export const DEFAULT_THREADS = [
  { id: "global", title: "团队调度台", time: "现在", kind: "room" },
];

export const DEFAULT_MESSAGES = [];

export const DEFAULT_COMMANDS = [];

export const DEFAULT_KNOWLEDGE = [];

export function createInitialState() {
  return {
    schemaVersion: 8,
    rooms: [DEFAULT_ROOM],
    activeRoomId: DEFAULT_ROOM.id,
    agentsByRoom: { [DEFAULT_ROOM.id]: DEFAULT_AGENTS.map((agent) => ({ ...agent })) },
    messagesByRoom: { [DEFAULT_ROOM.id]: DEFAULT_MESSAGES },
    commandsByRoom: { [DEFAULT_ROOM.id]: DEFAULT_COMMANDS },
    knowledgeByRoom: { [DEFAULT_ROOM.id]: DEFAULT_KNOWLEDGE },
    threadCache: { [DEFAULT_ROOM.id]: DEFAULT_THREADS },
    historyCacheByThread: {},
    contextCursorsByRoom: { [DEFAULT_ROOM.id]: {} },
    contextDeliverySequenceByRoom: { [DEFAULT_ROOM.id]: 0 },
    pendingContextCursorsByRoom: { [DEFAULT_ROOM.id]: [] },
    writeLocksByRoom: { [DEFAULT_ROOM.id]: null },
  };
}
