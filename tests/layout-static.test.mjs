import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
const indexHtml = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");

test("uses the product name in the browser tab", () => {
  assert.match(indexHtml, /<title>Codex Team Room<\/title>/);
  assert.doesNotMatch(indexHtml, /<title>Prototype<\/title>/);
});

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...styles.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm"))];
  const match = matches.find((candidate) => {
    const before = styles.slice(0, candidate.index).split(/\r?\n/).at(-1)?.trimEnd() || "";
    return !before.endsWith(",");
  });
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test("chat layout clamps grid min-content and keeps message scroll independent", () => {
  for (const selector of [".main-panel", ".main-content", ".chat-layout"]) {
    const block = rule(selector);
    assert.match(block, /min-height:\s*0\s*;/, `${selector} must allow grid shrinking`);
    assert.match(block, /overflow:\s*hidden\s*;/, `${selector} must contain overflowing content`);
  }

  assert.match(rule(".message-scroll"), /min-height:\s*0\s*;/);
  assert.match(rule(".message-scroll"), /overflow-y:\s*auto\s*;/);
  assert.match(rule(".history-view"), /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s*;/);
  assert.match(rule(".history-scroll"), /min-height:\s*0\s*;/);
  assert.match(rule(".history-scroll"), /overflow-y:\s*auto\s*;/);
});

test("narrow layouts use the dynamic viewport and reserve the mobile safe area", () => {
  const mobile = styles.match(/@media\s*\(max-width:\s*820px\)\s*\{([\s\S]*)$/)?.[1] || "";
  assert.match(mobile, /body\s*\{[^}]*overflow:\s*hidden\s*;/s);
  assert.match(mobile, /\.app-shell\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)[^}]*height:\s*100dvh[^}]*min-height:\s*100dvh[^}]*max-height:\s*100dvh[^}]*overflow:\s*hidden\s*;/s);
  assert.match(mobile, /\.sidebar\s*\{[^}]*min-height:\s*0[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto[^}]*;/s);
  assert.match(mobile, /\.main-panel\s*\{[^}]*height:\s*auto[^}]*min-height:\s*0[^}]*max-height:\s*none[^}]*;/s);
  assert.doesNotMatch(mobile, /\.main-panel\s*\{[^}]*height:\s*min\(720px,/s);
  assert.match(mobile, /\.composer-wrap\s*\{[^}]*padding-bottom:\s*calc\(14px\s*\+\s*env\(safe-area-inset-bottom\)\)\s*;/s);
});
