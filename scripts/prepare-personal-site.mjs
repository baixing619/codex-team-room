#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const hostingPath = path.join(root, ".openai", "hosting.json");
const hosting = JSON.parse(fs.readFileSync(hostingPath, "utf8"));
const detached = Boolean(hosting.project_id);
delete hosting.project_id;
fs.writeFileSync(hostingPath, `${JSON.stringify(hosting, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ readyForPersonalSite: true, detachedMaintainerSite: detached }));
