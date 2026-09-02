ALTER TABLE `runs` ADD `lane_billing` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `metered_spend_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `lane` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `lane_billing` text;