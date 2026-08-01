import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AGENTS } from "../src/data/defaults.js";
import { decideParticipation, shouldRequestCommand } from "../src/lib/participation.js";

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
  assert.equal(shouldRequestCommand("请实现并运行测试", decisions), true);
  assert.equal(shouldRequestCommand("请分析方向", decisions), false);
});
