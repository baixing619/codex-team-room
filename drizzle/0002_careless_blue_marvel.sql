ALTER TABLE `remote_tasks` ADD `attachments_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_tasks` ADD `shared_context_json` text DEFAULT '{}' NOT NULL;