CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`provider` text,
	`model` text,
	`mode` text DEFAULT 'basic' NOT NULL,
	`workspace_root` text,
	`history_snapshot` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_seq` ON `messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `provider_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`api_key` text,
	`base_url` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
