import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AGENTS } from "../src/data/defaults.js";
import { decideParticipation } from "../src/lib/participation.js";

test("coordinator always receives a message while unrelated members stay silent", () => {
  const result = decideParticipation("我们确认一下产品方向", DEFAULT_AGENTS);
  assert.equal(result.find((item) => item.agentId === "coordinator").decision, "speak");
  assert.equal(result.find((item) => item.agentId === "developer").decision, "silent");
  assert.equal(result.find((item) => item.agentId === "reviewer").decision, "silent");
});

test("role hints and mentions wake only relevant members", () => {
  const result = decideParticipation("@审核 请检查代码风险", DEFAULT_AGENTS);
  assert.equal(result.find((item) => item.agentId === "developer").decision, "speak");
  assert.equal(result.find((item) => item.agentId === "reviewer").decision, "speak");
  assert.equal(result.find((item) => item.agentId === "researcher").decision, "silent");
});

test("multiple Chinese member mentions override each member's normal silent strategy", () => {
  const agents = [
    ...DEFAULT_AGENTS,
    { id: "pro-owner", name: "PRO项目专员", role: "项目专员", participation: "review", permission: "read-only" },
  ];
  const result = decideParticipation("@总控 @开发 @审核 @资料 @PRO项目专员", agents);

  assert.equal(result.length, agents.length);
  assert.ok(result.every((item) => item.decision === "speak"));
  assert.ok(result.every((item) => item.reason === "收到直接提及或全体通知"));
});

test("full-width Chinese at-signs and compact multi-mentions are recognized", () => {
  const result = decideParticipation("＠开发、＠审核＠资料", DEFAULT_AGENTS);

  assert.equal(result.find((item) => item.agentId === "developer").decision, "speak");
  assert.equal(result.find((item) => item.agentId === "reviewer").decision, "speak");
  assert.equal(result.find((item) => item.agentId === "researcher").decision, "speak");
});

test("whole-team requests wake every member, including the recognition phrase", () => {
  for (const text of ["都出来认识下", "都出来", "全员发言", "大家出来", "所有人请介绍一下"]) {
    const result = decideParticipation(text, DEFAULT_AGENTS);
    assert.ok(result.every((item) => item.decision === "speak"), text);
  }
});

test("custom members participate through their configured strategy and role", () => {
  const agents = [
    { id: "always-member", name: "项目跟进", role: "进度协调", participation: "always", permission: "read-only" },
    { id: "review-member", name: "安全审查", role: "风险审核", participation: "review", permission: "read-only" },
    { id: "knowledge-member", name: "资料核验", role: "资料整理", participation: "knowledge", permission: "read-only" },
    { id: "api-owner", name: "接口实现", role: "后端开发", participation: "relevant", permission: "request-write" },
  ];
  const result = decideParticipation("请整理资料并检查接口安全风险", agents);

  assert.ok(result.every((item) => item.decision === "speak"));
});
