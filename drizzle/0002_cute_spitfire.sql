ALTER TABLE `messages` ADD `type` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `delivered_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `container_status` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `total_cost_usd` real DEFAULT 0 NOT NULL;