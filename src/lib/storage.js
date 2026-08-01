import { createInitialState } from "../data/defaults.js";
import { migrateTeamRoomState, STATE_SCHEMA_VERSION } from "./roomAgents.js";

const STORAGE_KEY = "codex-team-room:state:v1";

export function loadState() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (!value) return createInitialState();
    const parsed = JSON.parse(value);
    if (parsed.schemaVersion > STATE_SCHEMA_VERSION) return createInitialState();
    return migrateTeamRoomState(parsed);
  } catch {
    return createInitialState();
  }
}

export function saveState(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The prototype remains usable when browser storage is unavailable.
  }
}

export function resetState() {
  window.localStorage.removeItem(STORAGE_KEY);
  return createInitialState();
}

export { migrateTeamRoomState };
