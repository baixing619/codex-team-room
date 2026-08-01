#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const input = await new Promise((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { text += chunk; });
  process.stdin.on("end", () => {
    try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
  });
  process.stdin.on("error", reject);
});

const siteUrl = String(input.siteUrl || "").replace(/\/$/, "");
const ownerUserId = String(input.ownerUserId || "");
const siwcBypassToken = String(input.siwcBypassToken || "");
const cwd = path.resolve(String(input.cwd || ""));
if (!siteUrl.startsWith("https://") || !ownerUserId || siwcBypassToken.length < 24 || !fs.existsSync(cwd)) {
  throw new Error("siteUrl, ownerUserId, siwcBypassToken, and an existing cwd are required");
}

const directory = process.env.TEAM_ROOM_CONFIG_DIR ? path.resolve(process.env.TEAM_ROOM_CONFIG_DIR) : path.join(root, ".team-room");
const configPath = path.join(directory, "pairing.json");
const environmentPath = path.join(directory, "sites-environment.json");
const deviceSecret = crypto.randomBytes(32).toString("base64url");
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify({
  siteUrl,
  siwcBypassToken,
  deviceSecret,
  cwd,
  deviceId: `device-${crypto.randomUUID()}`,
  deviceLabel: String(input.deviceLabel || process.env.COMPUTERNAME || "个人电脑").slice(0, 120),
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
fs.writeFileSync(environmentPath, `${JSON.stringify({
  TEAM_ROOM_OWNER_USER_ID: ownerUserId,
  TEAM_ROOM_DEVICE_SECRET: deviceSecret,
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

console.log(JSON.stringify({ configured: true, configPath, sitesEnvironmentPath: environmentPath }));
