CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`name` text NOT NULL,
	`description` text,
	`system_prompt` text,
	`provider` text,
	`model` text,
	`mode` text DEFAULT 'basic' NOT NULL,
	`reasoning_effort` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`workspace_root` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`name` text NOT NULL,
	`transport` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`url` text,
	`headers` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `group_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `reasoning_effort` text;