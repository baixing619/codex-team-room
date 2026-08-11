const MAX_URL_LENGTH = 2_048;
const MAX_MESSAGE_LENGTH = 12_000;
const MAX_TOKENS = 80;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);

function trimBareUrl(value) {
  let next = String(value || "");
  while (/[.,;:!，。；：！、]$/.test(next)) next = next.slice(0, -1);
  while (next.endsWith(")") && (next.match(/\(/g)?.length || 0) < (next.match(/\)/g)?.length || 0)) next = next.slice(0, -1);
  while (next.endsWith("]") && (next.match(/\[/g)?.length || 0) < (next.match(/\]/g)?.length || 0)) next = next.slice(0, -1);
  return next;
}

export function sanitizeHttpUrl(raw) {
  const source = String(raw || "").trim();
  if (!source || source.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(source);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function isCommonImageUrl(raw) {
  const safe = sanitizeHttpUrl(raw);
  if (!safe) return false;
  const parsed = new URL(safe);
  const pathname = parsed.pathname.toLowerCase();
  if ([...IMAGE_EXTENSIONS].some((extension) => pathname.endsWith(extension))) return true;
  return ["format", "fm"].some((key) => {
    const value = String(parsed.searchParams.get(key) || "").toLowerCase();
    return IMAGE_EXTENSIONS.has(`.${value}`);
  });
}

function pushText(tokens, text) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.type === "text") previous.text += text;
  else tokens.push({ type: "text", text });
}

export function parseMessageRichText(value) {
  const source = String(value || "").slice(0, MAX_MESSAGE_LENGTH);
  const tokens = [];
  const pattern = /!\[([^\]\r\n]{0,300})\]\((https?:\/\/[^\s)]+)\)|\[([^\]\r\n]{1,300})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)/gi;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) && tokens.length < MAX_TOKENS) {
    pushText(tokens, source.slice(cursor, match.index));
    const markdownImageUrl = match[2];
    const markdownLinkUrl = match[4];
    const bareOriginal = match[5];
    const rawUrl = bareOriginal ? trimBareUrl(bareOriginal) : markdownImageUrl || markdownLinkUrl;
    const url = sanitizeHttpUrl(rawUrl);
    if (!url) {
      pushText(tokens, match[0]);
    } else if (markdownImageUrl) {
      tokens.push({ type: "image", alt: match[1] || "成员分享的图片", url });
    } else if (markdownLinkUrl) {
      tokens.push({ type: "link", label: match[3], url });
    } else if (isCommonImageUrl(url)) {
      tokens.push({ type: "image", alt: "成员分享的图片", url });
    } else {
      tokens.push({ type: "link", label: url, url });
    }
    if (bareOriginal && rawUrl.length < bareOriginal.length) pushText(tokens, bareOriginal.slice(rawUrl.length));
    cursor = match.index + match[0].length;
  }
  pushText(tokens, source.slice(cursor));
  return tokens;
}
