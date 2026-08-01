import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const excludedDirectories = new Set([".git", "node_modules", "dist", "work", "screenshots", "qa"]);
const forbiddenNames = new Set(["auth.json", "session_index.jsonl"]);
const textExtensions = new Set([".js", ".jsx", ".mjs", ".json", ".md", ".html", ".css", ".txt", ".yml", ".yaml"]);
const findings = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    const relative = path.relative(root, fullPath).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "sessions") findings.push(`${relative}: Codex session directory must not be published`);
      else walk(fullPath);
      continue;
    }
    if (forbiddenNames.has(entry.name) || (entry.name.startsWith(".env") && entry.name !== ".env.example")) {
      findings.push(`${relative}: forbidden private file`);
    }
    if (entry.name.endsWith(".jsonl") && !relative.startsWith("tests/fixtures/")) {
      findings.push(`${relative}: conversation-like JSONL is not allowed`);
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const text = fs.readFileSync(fullPath, "utf8");
    const patterns = [
      [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key material"],
      [/(?:OPENAI_API_KEY|CODEX_API_KEY)\s*[=:]\s*["']?(?!example|replace|your-)[A-Za-z0-9_-]{20,}/i, "API key-like value"],
      [/[A-Z]:\\Users\\[^\\\s]+\\(?:\.codex|AppData)\\/i, "user-private absolute path"],
    ];
    for (const [pattern, label] of patterns) {
      if (pattern.test(text)) findings.push(`${relative}: ${label}`);
    }
  }
}

walk(root);

if (!fs.existsSync(path.join(root, "LICENSE"))) findings.push("LICENSE: missing project license");
if (!fs.existsSync(path.join(root, "THIRD_PARTY_NOTICES.md"))) findings.push("THIRD_PARTY_NOTICES.md: missing dependency notices");

if (findings.length) {
  console.error("Release safety check failed:\n" + findings.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}

console.log("Release safety check passed: no private Codex data, credential files, or obvious secrets found.");
