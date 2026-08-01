import assert from "node:assert/strict";
import test from "node:test";
import { applyCloudSnapshot, createCloudSnapshot } from "../src/lib/cloudState.js";

function roomState({ rooms, activeRoomId, agentsByRoom, messagesByRoom, knowledgeByRoom }) {
  return {
    schemaVersion: 4,
    rooms,
    activeRoomId,
    agentsByRoom,
    messagesByRoom,
    commandsByRoom: Object.fromEntries(rooms.map((room) => [room.id, []])),
    knowledgeByRoom,
    threadCache: Object.fromEntries(rooms.map((room) => [room.id, [{ id: "global", title: "团队调度台", kind: "room" }] ])),
    writeLocksByRoom: Object.fromEntries(rooms.map((room) => [room.id, null])),
  };
}

test("applies a phone snapshot with new room data while retaining the computer active room and excluding File objects", () => {
  const desktopRoom = { id: "desktop-room", name: "电脑当前项目", path: "G:\\desktop-project", source: "local", connected: true };
  const mobileRoom = { id: "mobile-room", name: "手机新增项目", path: "G:\\mobile-project", source: "imported", connected: true };
  const localFile = new File(["本机附件内容"], "不上传的本机文件.txt", { type: "text/plain" });
  const phoneState = roomState({
    rooms: [desktopRoom, mobileRoom],
    activeRoomId: mobileRoom.id,
    agentsByRoom: {
      [desktopRoom.id]: [{ id: "coordinator", name: "总控", role: "协调" }],
      [mobileRoom.id]: [{ id: "mobile-researcher", name: "手机资料员", role: "知识核验", systemPrompt: "只处理当前项目" }],
    },
    messagesByRoom: {
      [desktopRoom.id]: [],
      [mobileRoom.id]: [{ id: "mobile-message", kind: "user", text: "手机新增的消息", attachments: [{ id: "attachment-1", name: "资料.txt", type: "text/plain", size: 18, file: localFile }] }],
    },
    knowledgeByRoom: {
      [desktopRoom.id]: [],
      [mobileRoom.id]: [{ id: "mobile-knowledge", title: "手机知识", category: "资料", body: "手机新增的知识条目" }],
    },
  });
  const computerState = roomState({
    rooms: [desktopRoom],
    activeRoomId: desktopRoom.id,
    agentsByRoom: { [desktopRoom.id]: [{ id: "old", name: "旧成员", role: "旧角色" }] },
    messagesByRoom: { [desktopRoom.id]: [{ id: "old-message", text: "电脑旧消息" }] },
    knowledgeByRoom: { [desktopRoom.id]: [] },
  });

  const snapshot = createCloudSnapshot(phoneState);
  const snapshotAttachment = snapshot.messagesByRoom[mobileRoom.id][0].attachments[0];
  const applied = applyCloudSnapshot(computerState, snapshot);

  assert.deepEqual(snapshotAttachment, { id: "attachment-1", name: "资料.txt", type: "text/plain", size: 18 });
  assert.equal("file" in snapshotAttachment, false);
  assert.equal(snapshotAttachment.file, undefined);
  assert.equal(applied.activeRoomId, desktopRoom.id);
  assert.ok(applied.rooms.some((room) => room.id === mobileRoom.id));
  assert.equal(applied.agentsByRoom[mobileRoom.id][0].name, "手机资料员");
  assert.equal(applied.knowledgeByRoom[mobileRoom.id][0].title, "手机知识");
  assert.equal(applied.messagesByRoom[mobileRoom.id][0].text, "手机新增的消息");
  assert.equal(applied.messagesByRoom[mobileRoom.id][0].attachments[0].file, undefined);
});
