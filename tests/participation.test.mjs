import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AGENTS } from "../src/data/defaults.js";
import { commandRequestingAgent, decideParticipation, shouldRequestCommand } from "../src/lib/participation.js";

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

test("execution requests require an active developer and action wording", () => {
  const decisions = decideParticipation("请实现并运行测试", DEFAULT_AGENTS);
  assert.equal(shouldRequestCommand("请实现并运行测试", decisions, DEFAULT_AGENTS), true);
  assert.equal(shouldRequestCommand("请分析方向", decisions, DEFAULT_AGENTS), false);
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
  assert.equal(commandRequestingAgent(result, agents).id, "api-owner");
  assert.equal(shouldRequestCommand("请修复接口并运行测试", result, agents), true);
});

test("a speaking custom write member can request a simulated command after default developer is removed", () => {
  const agents = [{ id: "builder", name: "构建员", role: "发布工程师", participation: "always", permission: "request-write" }];
  const decisions = decideParticipation("请构建并执行验证", agents);

  assert.equal(commandRequestingAgent(decisions, agents).id, "builder");
  assert.equal(shouldRequestCommand("请构建并执行验证", decisions, agents), true);
});
