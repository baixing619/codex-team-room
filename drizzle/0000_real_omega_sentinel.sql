CREATE TABLE `paired_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`version` text,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remote_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`decision` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`claimed_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_remote_approvals_status_created` ON `remote_approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `remote_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`task_id` text,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_remote_events_user_sequence` ON `remote_events` (`user_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `remote_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`room_id` text NOT NULL,
	`message_id` text NOT NULL,
	`text` text NOT NULL,
	`decisions_json` text NOT NULL,
	`agents_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`claimed_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_remote_tasks_status_created` ON `remote_tasks` (`status`,`created_at`);