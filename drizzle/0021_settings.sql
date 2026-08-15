CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`global_autonomy_paused` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
