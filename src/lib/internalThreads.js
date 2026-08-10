const INTERNAL_TEAM_ROOM_TITLE = /^\[TEAM_ROOM_(?:SHARED_CONTEXT|COORDINATOR_PROTOCOL|FINAL_SUMMARY_PROTOCOL|TASK_ASSIGNMENT|TASK_RESULT)_V\d+\]/i;

export function isInternalTeamRoomThreadTitle(value) {
  return INTERNAL_TEAM_ROOM_TITLE.test(String(value || "").trim());
}
