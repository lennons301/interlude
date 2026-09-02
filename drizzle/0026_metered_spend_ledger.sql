CREATE TABLE `metered_spend` (
	`day` text PRIMARY KEY NOT NULL,
	`usd` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
