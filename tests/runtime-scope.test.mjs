import assert from "node:assert/strict";
import test from "node:test";
import { runtimeMatchesRoom } from "../src/lib/runtimeScope.js";

test("local runtime scope requires both the project path and exact room id", () => {
  const runtime = { connected: true, cwd: "G:\\project\\", roomId: "room-one" };
  assert.equal(runtimeMatchesRoom(runtime, { id: "room-one", path: "g:\\PROJECT" }), true);
  assert.equal(runtimeMatchesRoom(runtime, { id: "room-two", path: "G:\\project" }), false);
  assert.equal(runtimeMatchesRoom({ ...runtime, cwd: "G:\\other" }, { id: "room-one", path: "G:\\project" }), false);
});
