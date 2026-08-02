ALTER TABLE `remote_approvals` ADD `approval_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_approvals_user_key` ON `remote_approvals` (`user_id`,`approval_key`);--> statement-breakpoint
ALTER TABLE `remote_events` ADD `event_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_events_user_device_event` ON `remote_events` (`user_id`,`device_id`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_tasks_user_message` ON `remote_tasks` (`user_id`,`message_id`);