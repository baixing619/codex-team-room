import assert from "node:assert/strict";
import test from "node:test";
import { isCommonImageUrl, parseMessageRichText, sanitizeHttpUrl } from "../src/lib/messageRichText.js";

test("parses safe web links and images without accepting active-content protocols", () => {
  const tokens = parseMessageRichText("主页：[项目](https://example.com/path)\n效果：![截图](https://cdn.example.com/demo.png?size=2)\n裸地址 https://example.com/docs。 javascript:alert(1)");
  assert.equal(tokens.some((item) => item.type === "link" && item.label === "项目" && item.url === "https://example.com/path"), true);
  assert.equal(tokens.some((item) => item.type === "image" && item.alt === "截图" && item.url.includes("demo.png")), true);
  assert.equal(tokens.some((item) => item.type === "link" && item.url === "https://example.com/docs"), true);
  assert.equal(tokens.some((item) => item.type !== "text" && /javascript:/i.test(item.url || "")), false);
  assert.equal(tokens.map((item) => item.text || "").join("").includes("javascript:alert(1)"), true);
});

test("recognizes only raster image URLs and keeps unsafe URL schemes inert", () => {
  assert.equal(isCommonImageUrl("https://images.example.com/render?format=webp"), true);
  assert.equal(isCommonImageUrl("https://example.com/page.html"), false);
  assert.equal(sanitizeHttpUrl("https://user:pass@example.com/private"), null);
  assert.equal(sanitizeHttpUrl("data:image/png;base64,aaa"), null);
  assert.equal(sanitizeHttpUrl("file:///C:/secret.txt"), null);
});

test("leaves script-like text as escaped React data and caps excessive input", () => {
  const tokens = parseMessageRichText(`<script>alert(1)</script> ${"x".repeat(20_000)}`);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text.startsWith("<script>alert(1)</script>"), true);
  assert.equal(tokens.reduce((sum, token) => sum + String(token.text || token.label || "").length, 0) <= 12_000, true);
});
