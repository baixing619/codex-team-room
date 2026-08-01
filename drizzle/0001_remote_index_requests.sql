ALTER TABLE `remote_tasks` ADD `cwd` text;
--> statement-breakpoint
CREATE TABLE `remote_index_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_type` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`claimed_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_remote_index_requests_status_created` ON `remote_index_requests` (`status`,`created_at`);
