import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("indexes metadata and exposes only visible user and assistant messages", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: "thread-1", thread_name: "测试对话", updated_at: "2026-08-01T10:00:00Z" })}\n`);
  fs.writeFileSync(
    path.join(sessions, "rollout-test.jsonl"),
    [
      { type: "session_meta", payload: { id: "thread-1", cwd: "G:\\\\demo", timestamp: "2026-08-01T09:00:00Z" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<app-context>secret internal context</app-context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_delegation>private coordination metadata</codex_delegation>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<app-context>private shell context</app-context>" }, { type: "input_text", text: "同一轮的可见追问" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "这是用户可见消息" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "这是助手回复" }] } },
    ].map((item) => JSON.stringify(item)).join("\n"),
  );

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?test=${Date.now()}`);
  const projects = indexModule.listProjects();
  const result = indexModule.readVisibleMessages("thread-1");

  assert.equal(projects.length, 1);
  assert.equal(projects[0].threadCount, 1);
  assert.deepEqual(result.messages.map((message) => message.text), ["同一轮的可见追问", "这是用户可见消息", "这是助手回复"]);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("reads only the recent tail of a large rollout and keeps the newest visible messages", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-tail-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: "thread-tail", thread_name: "大历史", updated_at: "2026-08-01T10:00:00Z" })}\n`);
  const rolloutPath = path.join(sessions, "rollout-tail.jsonl");
  const finalMessages = [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "最近的用户消息" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "最近的助手回复" }] } },
  ].map((item) => JSON.stringify(item)).join("\n");
  fs.writeFileSync(rolloutPath, `${JSON.stringify({ type: "session_meta", payload: { id: "thread-tail", cwd: "G:\\\\demo", timestamp: "2026-08-01T09:00:00Z" } })}\n${"x".repeat(5 * 1024 * 1024)}\n${finalMessages}\n`);

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?tail-test=${Date.now()}`);
  const result = indexModule.readVisibleMessages("thread-tail");

  assert.deepEqual(result.messages.map((message) => message.text), ["最近的用户消息", "最近的助手回复"]);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("indexes a session when its session_meta line is larger than the initial read chunk", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-large-meta-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessions, { recursive: true });
  const threadId = "thread-large-meta";
  const projectPath = "G:\\large-meta-project";
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: threadId, thread_name: "超长元数据对话", updated_at: "2026-08-01T10:00:00Z" })}\n`);
  const meta = {
    type: "session_meta",
    payload: {
      id: threadId,
      cwd: projectPath,
      timestamp: "2026-08-01T09:00:00Z",
      base_instructions: { text: "x".repeat(24 * 1024) },
    },
  };
  fs.writeFileSync(path.join(sessions, "rollout-large-meta.jsonl"), `${JSON.stringify(meta)}\n`);

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?large-meta-test=${Date.now()}`);
  const projects = indexModule.listProjects();

  assert.deepEqual(projects.map((project) => project.path), [projectPath]);
  assert.equal(indexModule.listThreads(projectPath)[0].title, "超长元数据对话");

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("derives a short Chinese title from the first visible user message in a large old rollout", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-fallback-title-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessions, { recursive: true });
  const threadId = "thread-fallback-title";
  const projectPath = "G:\\fallback-title-project";
  const rolloutPath = path.join(sessions, "rollout-fallback-title.jsonl");
  const firstVisibleMessage = "请帮我为团队调度台补全历史对话标题，并且不要读取整份旧记录。";
  const lines = [
    { type: "session_meta", payload: { id: threadId, cwd: projectPath, timestamp: "2026-08-01T09:00:00Z", base_instructions: { text: "x".repeat(24 * 1024) } } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<app-context>内部应用状态</app-context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>内部运行环境</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>内部规则</INSTRUCTIONS>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<INSTRUCTIONS>独立的内部规则块</INSTRUCTIONS>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "The following is the Codex agent history whose rollout details must stay internal." }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "response_annotation", text: "不应成为标题" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "也不应成为标题", annotations: [{ type: "response_annotation" }] }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: firstVisibleMessage }] } },
  ];
  fs.writeFileSync(rolloutPath, `${lines.map((item) => JSON.stringify(item)).join("\n")}\n${"z".repeat(6 * 1024 * 1024)}\n`);

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?fallback-title-test=${Date.now()}`);
  const [thread] = indexModule.listThreads(projectPath);

  assert.equal(thread.title, firstVisibleMessage);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("hides every spawned subagent session from the standard conversation index", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-subagent-index-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  const projectPath = "G:\\subagent-title-project";
  fs.mkdirSync(sessions, { recursive: true });
  const guardian = {
    type: "session_meta",
    payload: {
      id: "guardian-thread",
      cwd: projectPath,
      timestamp: "2026-08-01T09:00:00Z",
      source: { subagent: { other: "guardian" } },
    },
  };
  const spawned = {
    type: "session_meta",
    payload: {
      id: "spawned-thread",
      cwd: projectPath,
      timestamp: "2026-08-01T10:00:00Z",
      source: { subagent: { thread_spawn: { agent_nickname: "Jason", agent_path: "/root/terra_review" } } },
    },
  };
  fs.writeFileSync(path.join(sessions, "rollout-guardian.jsonl"), `${JSON.stringify(guardian)}\n`);
  fs.writeFileSync(path.join(sessions, "rollout-spawned.jsonl"), `${JSON.stringify(spawned)}\n`);

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?subagent-title-test=${Date.now()}`);
  const projects = indexModule.listProjects();
  const threads = indexModule.listThreads(projectPath);

  assert.deepEqual(projects, []);
  assert.deepEqual(threads, []);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("keeps Team Room managed standard conversations visible while subagents stay separate", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-internal-thread-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  const projectPath = "G:\\internal-team-room-project";
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = [
    { type: "session_meta", payload: { id: "internal-thread", cwd: projectPath, timestamp: "2026-08-01T09:00:00Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "[TEAM_ROOM_SHARED_CONTEXT_V1]\n内部共享上下文\n[/TEAM_ROOM_SHARED_CONTEXT_V1]\n\n用户当前请求：检查项目" }] } },
  ];
  fs.writeFileSync(path.join(sessions, "rollout-internal.jsonl"), `${rollout.map((item) => JSON.stringify(item)).join("\n")}\n`);

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?internal-thread-test=${Date.now()}`);

  assert.equal(indexModule.listThreads(projectPath).length, 1);
  assert.match(indexModule.listThreads(projectPath)[0].title, /^\[TEAM_ROOM_SHARED_CONTEXT_V1\]/);
  assert.equal(indexModule.listProjects().length, 1);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("shows only the standard root conversation for a project reached through hidden subagent descendants", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-ancestor-project-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  const projectPath = "G:\\ancestor-project";
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: "root-thread", thread_name: "规划 Codex 持久化改动", updated_at: "2026-08-01T12:00:00Z" })}\n`);
  const root = {
    type: "session_meta",
    payload: { id: "root-thread", cwd: "C:\\outside-project", timestamp: "2026-08-01T09:00:00Z" },
  };
  const intermediate = {
    type: "session_meta",
    payload: {
      id: "intermediate-thread",
      cwd: "C:\\other-project",
      timestamp: "2026-08-01T10:00:00Z",
      source: { subagent: { thread_spawn: { parent_thread_id: "root-thread", agent_nickname: "Planner", agent_path: "/root/planner" } } },
    },
  };
  const child = {
    type: "session_meta",
    payload: {
      id: "child-thread",
      cwd: projectPath,
      timestamp: "2026-08-01T11:00:00Z",
      source: { subagent: { thread_spawn: { parent_thread_id: "intermediate-thread", agent_nickname: "Worker", agent_path: "/root/worker" } } },
    },
  };
  const guardian = {
    type: "session_meta",
    payload: {
      id: "guardian-thread",
      cwd: projectPath,
      timestamp: "2026-08-01T11:30:00Z",
      source: { subagent: { other: "guardian" } },
    },
  };
  for (const [name, item] of [["root", root], ["intermediate", intermediate], ["child", child], ["guardian", guardian]]) {
    fs.writeFileSync(path.join(sessions, `rollout-${name}.jsonl`), `${JSON.stringify(item)}\n`);
  }

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?ancestor-project-test=${Date.now()}`);
  const threads = indexModule.listThreads(projectPath);
  const titlesById = new Map(threads.map((thread) => [thread.id, thread.title]));
  const project = indexModule.listProjects().find((item) => item.path === projectPath);

  assert.equal(project.threadCount, 1);
  assert.equal(titlesById.has("child-thread"), false);
  assert.equal(titlesById.has("intermediate-thread"), false);
  assert.equal(titlesById.get("root-thread"), "规划 Codex 持久化改动");
  assert.equal(titlesById.has("guardian-thread"), false);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("uses the newest bounded-tail turn context cwd instead of the initial temporary cwd", async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-room-recent-cwd-test-"));
  const sessions = path.join(home, "sessions", "2026", "08", "01");
  const initialCwd = "C:\\Users\\zhang\\Documents\\Codex\\temporary-chat";
  const targetProject = "G:\\recent-cwd-project";
  const threadId = "thread-recent-cwd";
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(home, "session_index.jsonl"), `${JSON.stringify({ id: threadId, thread_name: "延续Pro订阅回本策略", updated_at: "2026-08-01T12:00:00Z" })}\n`);
  const rollout = [
    { type: "session_meta", payload: { id: threadId, cwd: initialCwd, timestamp: "2026-08-01T09:00:00Z" } },
    { type: "turn_context", payload: { cwd: initialCwd } },
  ].map((item) => JSON.stringify(item)).join("\n");
  const newestContext = JSON.stringify({ type: "turn_context", payload: { cwd: targetProject } });
  fs.writeFileSync(path.join(sessions, "rollout-recent-cwd.jsonl"), `${rollout}\n${"x".repeat(2 * 1024 * 1024)}\n${newestContext}\n`);

  process.env.CODEX_HOME = home;
  const indexModule = await import(`../server/codexSessionIndex.mjs?recent-cwd-test=${Date.now()}`);
  const projects = indexModule.listProjects();
  const threads = indexModule.listThreads(targetProject);

  assert.deepEqual(projects.map((project) => project.path), [targetProject]);
  assert.deepEqual(threads.map((thread) => ({ id: thread.id, title: thread.title })), [{ id: threadId, title: "延续Pro订阅回本策略" }]);
  assert.equal(indexModule.listThreads(initialCwd).length, 0);

  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});
