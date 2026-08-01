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
    systemPrompt: "你是“总控”，在当前项目中担任项目经理。负责澄清目标、拆分任务并协调节奏；只处理当前项目和本轮任务相关的信息。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。高影响操作必须先说明影响并遵守用户审批。",
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
    systemPrompt: "你是“开发”，在当前项目中担任实现工程师。负责独立实现、验证和清楚说明变更；只处理当前项目和本轮任务相关的信息。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。任何写入必须先经过用户的明确审批。",
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
    systemPrompt: "你是“审核”，在当前项目中担任质量审核员。独立检查正确性、安全性、回归风险和遗漏；只处理当前项目和本轮任务相关的信息。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。未经用户授权不要实施写入操作。",
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
    systemPrompt: "你是“资料”，在当前项目中担任知识管理员。整理与核对已确认信息，标记不确定性和来源边界；只处理当前项目和本轮任务相关的信息。不要读取、泄露或转发其他项目、其他对话、密钥、凭据或私人上下文。未经用户授权不要实施写入操作。",
    status: "active",
    statusLabel: "待命",
    avatar: "/assets/agents/agent-researcher.png",
    color: "orange",
  },
];

export const DEFAULT_ROOM = {
  id: "team-room-prototype",
  name: "Team Room 原型",
  path: ".",
  source: "local",
  connected: true,
};

export const DEFAULT_THREADS = [
  { id: "global", title: "团队调度台", time: "09:42", kind: "room" },
  { id: "requirements", title: "需求澄清", time: "昨天", kind: "demo" },
  { id: "api", title: "接口设计讨论", time: "昨天", kind: "demo" },
  { id: "review", title: "代码评审记录", time: "7月31日", kind: "demo" },
  { id: "deploy", title: "部署与验证", time: "7月30日", kind: "demo" },
];

export const DEFAULT_MESSAGES = [
  {
    id: "m1",
    kind: "agent",
    agentId: "coordinator",
    time: "昨天 16:23",
    text: "团队目标已经对齐：主屏保持群聊优先，同时保留知识库、成员配置与安全执行流程。",
  },
  {
    id: "m2",
    kind: "agent",
    agentId: "developer",
    time: "昨天 16:28",
    text: "收到。我会先完成本地数据层和项目接入，再连接真实 Codex 运行时。",
  },
  {
    id: "m3",
    kind: "agent",
    agentId: "reviewer",
    time: "昨天 16:31",
    text: "我会独立检查权限边界，确保共享信息不包含密钥和私人会话原文。",
  },
  {
    id: "m4",
    kind: "system",
    time: "16:45",
    text: "审核判断当前无需补充，保持静默",
  },
  {
    id: "m5",
    kind: "agent",
    agentId: "researcher",
    time: "昨天 16:46",
    text: "我会维护公共知识条目、已确认决定和开源许可证清单。",
  },
  { id: "day", kind: "divider", text: "8月1日 今天" },
  {
    id: "m6",
    kind: "agent",
    agentId: "coordinator",
    time: "09:15",
    text: "开发已提交一个受控写入请求，请你决定是否允许。",
  },
];

export const DEFAULT_COMMANDS = [
  {
    id: "command-1",
    agentId: "developer",
    title: "更新本地团队房间状态",
    command: "npm run verify:room-state",
    summary: "验证消息、成员配置和知识库的本地持久化结构。",
    target: "Team Room 本地工作区",
    impact: "只读验证",
    risk: "低",
    status: "pending",
    time: "09:15",
  },
];

export const DEFAULT_KNOWLEDGE = [
  {
    id: "knowledge-1",
    title: "产品边界",
    category: "已确认决定",
    body: "方案 1 只决定视觉语言。知识库、成员配置、项目导入、自动发言判断和命令审批都属于完整产品范围。",
    updatedAt: "今天 10:18",
  },
  {
    id: "knowledge-2",
    title: "隐私原则",
    category: "安全规则",
    body: "默认只读取 Codex 会话元数据。导入聊天正文必须由用户主动选择，密钥、认证文件和项目私有内容永不进入公共仓库。",
    updatedAt: "今天 10:24",
  },
  {
    id: "knowledge-3",
    title: "开源发布",
    category: "发布要求",
    body: "原创实现；维护依赖许可证清单；不打包 Codex、用户账号、聊天记录或未知来源素材。",
    updatedAt: "今天 10:31",
  },
];

export function createInitialState() {
  return {
    schemaVersion: 3,
    rooms: [DEFAULT_ROOM],
    activeRoomId: DEFAULT_ROOM.id,
    agentsByRoom: { [DEFAULT_ROOM.id]: DEFAULT_AGENTS.map((agent) => ({ ...agent })) },
    messagesByRoom: { [DEFAULT_ROOM.id]: DEFAULT_MESSAGES },
    commandsByRoom: { [DEFAULT_ROOM.id]: DEFAULT_COMMANDS },
    knowledgeByRoom: { [DEFAULT_ROOM.id]: DEFAULT_KNOWLEDGE },
    threadCache: { [DEFAULT_ROOM.id]: DEFAULT_THREADS },
    writeLocksByRoom: { [DEFAULT_ROOM.id]: null },
  };
}
