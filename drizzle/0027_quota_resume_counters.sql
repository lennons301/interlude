ALTER TABLE `runs` ADD `resume_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `resumed_from_task_id` text;