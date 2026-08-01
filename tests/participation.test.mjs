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
