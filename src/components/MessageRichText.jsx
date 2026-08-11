import { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { parseMessageRichText } from "../lib/messageRichText.js";

function hostname(url) {
  try { return new URL(url).hostname; } catch { return "网页"; }
}

function SafeMessageImage({ token }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <a className="message-link-preview" href={token.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer"><span>图片无法直接预览，点击打开</span><small>{hostname(token.url)} <ArrowSquareOut size={13} /></small></a>;
  }
  return (
    <figure className="message-image-preview">
      <a href={token.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        <img src={token.url} alt={token.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </a>
      <figcaption>{token.alt}</figcaption>
    </figure>
  );
}

export function MessageRichText({ text }) {
  const tokens = parseMessageRichText(text);
  return (
    <div className="message-rich-text">
      {tokens.map((token, index) => {
        if (token.type === "image") return <SafeMessageImage key={`${token.url}-${index}`} token={token} />;
        if (token.type === "link") {
          return (
            <a key={`${token.url}-${index}`} className="message-link-preview" href={token.url} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
              <span>{token.label}</span>
              <small>{hostname(token.url)} <ArrowSquareOut size={13} /></small>
            </a>
          );
        }
        return <span key={`text-${index}`}>{token.text}</span>;
      })}
    </div>
  );
}
