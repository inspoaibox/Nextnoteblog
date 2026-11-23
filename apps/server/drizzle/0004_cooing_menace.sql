CREATE TABLE `links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`avatar` text DEFAULT '' NOT NULL,
	`group_name` text DEFAULT '' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`visible` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `links_sort` ON `links` (`sort`);--> statement-breakpoint
CREATE TABLE `project_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`locale` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_translations_pk` ON `project_translations` (`project_id`,`locale`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`repo_url` text DEFAULT '' NOT NULL,
	`homepage` text DEFAULT '' NOT NULL,
	`docs_url` text DEFAULT '' NOT NULL,
	`download_url` text DEFAULT '' NOT NULL,
	`license` text DEFAULT '' NOT NULL,
	`language` text DEFAULT '' NOT NULL,
	`logo` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`featured` integer DEFAULT 0 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`visible` integer DEFAULT 1 NOT NULL,
	`tag_id` integer,
	`stars` integer DEFAULT 0 NOT NULL,
	`forks` integer DEFAULT 0 NOT NULL,
	`latest_version` text DEFAULT '' NOT NULL,
	`release_url` text DEFAULT '' NOT NULL,
	`released_at` integer,
	`synced_at` integer,
	`sync_error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `projects_sort` ON `projects` (`featured`,`sort`);