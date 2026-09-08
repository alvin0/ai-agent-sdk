CREATE TABLE `usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`group_id` text,
	`run_id` text NOT NULL,
	`member` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_events_model` ON `usage_events` (`provider`,`model`,`effort`);--> statement-breakpoint
CREATE INDEX `usage_events_conversation` ON `usage_events` (`conversation_id`);