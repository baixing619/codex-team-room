import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pairedDevices = sqliteTable("paired_devices", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  version: text("version"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const remoteTasks = sqliteTable("remote_tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  roomId: text("room_id").notNull(),
  messageId: text("message_id").notNull(),
  text: text("text").notNull(),
  decisionsJson: text("decisions_json").notNull(),
  agentsJson: text("agents_json").notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at"),
}, (table) => [index("idx_remote_tasks_status_created").on(table.status, table.createdAt)]);

export const remoteEvents = sqliteTable("remote_events", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  taskId: text("task_id"),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_remote_events_user_sequence").on(table.userId, table.sequence)]);

export const remoteApprovals = sqliteTable("remote_approvals", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  requestId: text("request_id").notNull(),
  decision: text("decision").notNull(),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at"),
}, (table) => [index("idx_remote_approvals_status_created").on(table.status, table.createdAt)]);
