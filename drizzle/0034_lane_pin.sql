CREATE TABLE `lane_pins` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`issue_number` integer NOT NULL,
	`lane` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `lane_pin` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `lane_pin` text;