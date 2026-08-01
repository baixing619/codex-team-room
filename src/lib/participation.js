const ROLE_HINTS = {
  developer: ["开发", "代码", "实现", "接口", "修复", "命令", "文件", "测试", "构建"],
  reviewer: ["审核", "检查", "风险", "复核", "合规", "质量", "遗漏", "安全"],
  researcher: ["资料", "知识", "文档", "历史", "搜索", "来源", "设定", "记录"],
};

export function decideParticipation(text, agents) {
  const normalized = text.trim().toLowerCase();
  const broadcast = normalized.includes("@全体") || normalized.includes("大家") || normalized.includes("所有人");

  return agents.map((agent) => {
    if (agent.id === "coordinator") {
      return { agentId: agent.id, decision: "speak", reason: "总控负责接收并路由每条项目消息" };
    }

    const directlyMentioned = normalized.includes(`@${agent.name}`) || normalized.includes(`@${agent.id}`);
    const hints = ROLE_HINTS[agent.id] ?? [];
    const relevant = hints.some((hint) => normalized.includes(hint));
    const shouldSpeak = broadcast || directlyMentioned || relevant;

    return {
      agentId: agent.id,
      decision: shouldSpeak ? "speak" : "silent",
      reason: shouldSpeak ? "职责或提及与当前消息相关" : "与当前职责无直接关系",
    };
  });
}

export function createAgentReply(agent, text) {
  const shortText = text.length > 44 ? `${text.slice(0, 44)}…` : text;
  const replies = {
    coordinator: `收到。我会围绕“${shortText}”协调分工，并把确认结果同步到公共上下文。`,
    developer: `我可以负责实现部分。我会先列出影响范围，涉及写入时再提交审批。`,
    reviewer: `我会独立检查边界、风险和验收条件，不直接修改文件。`,
    researcher: `我会核对相关资料，并把可复用结论整理进知识库。`,
  };
  return replies[agent.id] ?? "收到，我会按职责处理。";
}

export function shouldRequestCommand(text, decisions) {
  const actionWords = ["执行", "运行", "修改", "实现", "修复", "构建", "安装", "提交"];
  return (
    decisions.some((item) => item.agentId === "developer" && item.decision === "speak") &&
    actionWords.some((word) => text.includes(word))
  );
}

