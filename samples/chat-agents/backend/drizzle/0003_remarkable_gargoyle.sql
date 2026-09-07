CREATE TABLE `tool_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_root` text NOT NULL,
	`rule_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_permissions_root` ON `tool_permissions` (`workspace_root`);