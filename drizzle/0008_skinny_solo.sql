CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`github_issue` text NOT NULL,
	`attempt` integer NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'claimed' NOT NULL,
	`budget_usd` real NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`pull_request_number` integer,
	`pull_request_url` text,
	`gate_categories` text DEFAULT '[]' NOT NULL,
	`review_verdict` text,
	`review_cycle_count` integer DEFAULT 0 NOT NULL,
	`interruption_count` integer DEFAULT 0 NOT NULL,
	`blocked_question` text,
	`claimed_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `autonomy_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `preflight_status` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `preflight_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kind` text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `run_id` text REFERENCES runs(id);