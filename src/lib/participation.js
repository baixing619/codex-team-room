const ROLE_HINTS = {
  developer: ["开发", "代码", "实现", "接口", "修复", "命令", "文件", "测试", "构建"],
  reviewer: ["审核", "检查", "风险", "复核", "合规", "质量", "遗漏", "安全"],
  researcher: ["资料", "知识", "文档", "历史", "搜索", "来源", "设定", "记录"],
};

const PARTICIPATION_HINTS = {
  review: ["审核", "检查", "风险", "复核", "合规", "质量", "遗漏", "安全", "审查", "核对"],
  knowledge: ["资料", "知识", "文档", "历史", "搜索", "来源", "设定", "记录", "查询", "整理"],
};

function lexicalHints(agent) {
  const text = [agent.name, agent.role, agent.description]
    .filter((value) => typeof value === "string")
    .join(" ")
    .replace(/[\s\p{P}\p{S}]+/gu, " ");
  const hints = new Set();
  for (const word of text.split(" ").map((value) => value.trim()).filter((value) => value.length >= 2)) {
    hints.add(word.toLowerCase());
    for (let index = 0; index < word.length - 1; index += 1) hints.add(word.slice(index, index + 2).toLowerCase());
  }
  return [...hints];
}
function participationFor(agent) {
  if (["always", "relevant", "review", "knowledge"].includes(agent.participation)) return agent.participation;
  return agent.id === "coordinator" ? "always" : "relevant";
}

function matchingHints(agent) {
  const participation = participationFor(agent);
  return [
    ...(ROLE_HINTS[agent.id] || []),
    ...(PARTICIPATION_HINTS[participation] || []),
    ...lexicalHints(agent),
  ].map((hint) => hint.toLowerCase());
}

export function decideParticipation(text, agents) {
  const normalized = String(text || "").trim().toLowerCase();
  const broadcast = normalized.includes("@全体") || normalized.includes("大家") || normalized.includes("所有人");

  return (agents || []).map((agent) => {
    const agentName = String(agent.name || "").trim().toLowerCase();
    const agentId = String(agent.id || "").trim().toLowerCase();
    const directlyMentioned = (agentName && normalized.includes(`@${agentName}`)) || (agentId && normalized.includes(`@${agentId}`));
    const participation = participationFor(agent);
    const relevant = matchingHints(agent).some((hint) => hint && normalized.includes(hint));
    const shouldSpeak = participation === "always" || broadcast || directlyMentioned || relevant;
    const reason = participation === "always"
      ? "此成员配置为每条消息都参与"
      : broadcast || directlyMentioned
        ? "收到直接提及或全体通知"
        : relevant
          ? "职责、配置策略或成员角色与当前消息相关"
          : "与当前项目成员的职责和参与策略无直接关系";

    return { agentId: agent.id, decision: shouldSpeak ? "speak" : "silent", reason };
  });
}
