CREATE TABLE `trace_spans` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`seq` integer NOT NULL,
	`member` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer,
	`status` text NOT NULL,
	`attributes` text,
	`input` text,
	`output` text,
	`usage` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `trace_spans_run` ON `trace_spans` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `trace_spans_conversation` ON `trace_spans` (`conversation_id`,`started_at`);