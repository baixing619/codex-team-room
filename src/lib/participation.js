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

function normalizeMessage(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200B\u200C\u200D\uFEFF]/gu, "")
    .trim();
}

function mentionVariants(value) {
  const normalized = normalizeMessage(value).replace(/^@+/u, "");
  if (!normalized) return [];
  return Array.from(new Set([normalized, normalized.replace(/\s+/gu, "")])).filter(Boolean);
}

function hasMention(normalizedText, value) {
  return mentionVariants(value).some((variant) => {
    const marker = `@${variant}`;
    let offset = normalizedText.indexOf(marker);
    while (offset >= 0) {
      const after = normalizedText[offset + marker.length];
      // Require a token boundary after the alias so @开发不会误命中 @开发者；
      // punctuation also lets compact Chinese mentions such as @开发、@审核 work.
      if (after == null || /[\s\p{P}\p{S}]/u.test(after)) return true;
      offset = normalizedText.indexOf(marker, offset + 1);
    }
    return false;
  });
}

export function isBroadcastRequest(text) {
  const normalized = normalizeMessage(text);
  return ["都出来", "全员", "全体", "大家", "所有人"].some((hint) => normalized.includes(hint));
}

export function isAgentMentioned(text, agent) {
  const normalized = normalizeMessage(text);
  if (!normalized || !agent) return false;
  return hasMention(normalized, agent.name) || hasMention(normalized, agent.id);
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
  const normalized = normalizeMessage(text);
  const broadcast = isBroadcastRequest(normalized);

  return (agents || []).map((agent) => {
    const directlyMentioned = isAgentMentioned(normalized, agent);
    const participation = participationFor(agent);
    const relevant = matchingHints(agent).some((hint) => hint && normalized.includes(hint));
    const shouldSpeak = participation === "always" || broadcast || directlyMentioned || relevant;
    const reason = broadcast || directlyMentioned
      ? "收到直接提及或全体通知"
      : participation === "always"
        ? "此成员配置为每条消息都参与"
        : relevant
          ? "职责、配置策略或成员角色与当前消息相关"
          : "与当前项目成员的职责和参与策略无直接关系";

    return { agentId: agent.id, decision: shouldSpeak ? "speak" : "silent", reason };
  });
}
