CREATE TABLE `theme_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`theme_id` text NOT NULL,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `theme_log_created` ON `theme_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `theme_state` (
	`theme_id` text PRIMARY KEY NOT NULL,
	`active_version` text DEFAULT '' NOT NULL,
	`previous_version` text DEFAULT '' NOT NULL,
	`trusted` integer DEFAULT 0 NOT NULL,
	`config_draft` text DEFAULT '{}' NOT NULL,
	`config_applied` text DEFAULT '{}' NOT NULL,
	`config_previous` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
