export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "csv", "tsv", "log", "json", "jsonl", "yaml", "yml", "xml", "html", "css",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "ps1", "sh", "bat", "cmd", "sql", "toml", "ini",
  "java", "go", "rs", "c", "h", "cpp", "hpp", "cs", "php", "rb", "swift", "kt", "gradle",
]);

function limitedText(value, max) {
  return String(value || "").trim().slice(0, max);
}

export function isSupportedAttachment(file) {
  const type = String(file?.type || "").toLowerCase().split(";", 1)[0];
  const extension = String(file?.name || "").toLowerCase().split(".").at(-1);
  return type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("text/")
    || ["application/json", "application/xml", "application/javascript", "application/sql", "application/yaml", "application/x-yaml"].includes(type)
    || TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

export function validateSelectedFiles(files, currentCount = 0) {
  const accepted = [];
  const errors = [];
  for (const file of Array.from(files || [])) {
    if (currentCount + accepted.length >= MAX_ATTACHMENTS) {
      errors.push(`每条消息最多 ${MAX_ATTACHMENTS} 个附件`);
      break;
    }
    if (!file?.size) {
      errors.push(`${file?.name || "附件"}为空文件`);
    } else if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name}超过 10 MB`);
    } else if (!isSupportedAttachment(file)) {
      errors.push(`${file.name}暂不支持；请选择图片、音频、文本或代码文件`);
    } else {
      accepted.push(file);
    }
  }
  return { accepted, errors };
}

export function buildRoomSharedContext({ room, messages, knowledge, agents, contextId }) {
  const agentById = new Map((agents || []).map((agent) => [agent.id, agent]));
  return {
    id: limitedText(contextId, 160),
    roomId: limitedText(room?.id, 160),
    roomName: limitedText(room?.name, 300),
    knowledge: (knowledge || []).slice(0, 40).map((entry) => ({
      id: limitedText(entry.id, 160),
      title: limitedText(entry.title, 300),
      category: limitedText(entry.category, 120),
      body: limitedText(entry.body, 8_000),
    })),
    recentMessages: (messages || []).filter((message) => ["user", "agent", "system"].includes(message.kind)).slice(-40).map((message) => ({
      id: limitedText(message.id, 160),
      role: message.kind,
      agentId: limitedText(message.agentId, 160),
      agentName: limitedText(agentById.get(message.agentId)?.name, 200),
      sourceThreadId: limitedText(message.threadId, 200),
      text: limitedText(message.text, 2_000),
    })),
  };
}

export function formatAttachmentSize(value) {
  const size = Number(value) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}
