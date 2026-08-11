function normalizedPath(value) {
  return String(value || "").trim().replace(/[\\/]+$/, "").toLowerCase();
}

export function runtimeMatchesRoom(runtime, room) {
  if (!runtime?.connected || !room?.id) return false;
  return String(runtime.roomId || "") === String(room.id)
    && normalizedPath(runtime.cwd) === normalizedPath(room.path);
}
