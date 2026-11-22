CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`entity` text DEFAULT '' NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `languages` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`original_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`hash` text NOT NULL,
	`alt` text DEFAULT '' NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`uploader_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_path_unique` ON `media` (`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_hash_unique` ON `media` (`hash`);--> statement-breakpoint
CREATE TABLE `post_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_revision_id` integer,
	`draft_revision_id` integer,
	`scheduled_at` integer,
	`first_published_at` integer,
	`published_at` integer,
	`content_updated_at` integer,
	`view_count` integer DEFAULT 0 NOT NULL,
	`lock_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_translations_locale_slug` ON `post_translations` (`locale`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `post_translations_post_locale` ON `post_translations` (`post_id`,`locale`);--> statement-breakpoint
CREATE INDEX `post_translations_status` ON `post_translations` (`status`,`first_published_at`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer,
	`pinned` integer DEFAULT 0 NOT NULL,
	`featured` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `publish_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`translation_id` integer NOT NULL,
	`revision_id` integer,
	`action` text NOT NULL,
	`user_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`translation_id`) REFERENCES `post_translations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `publish_log_translation` ON `publish_log` (`translation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `redirects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_path` text NOT NULL,
	`to_path` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redirects_from_path_unique` ON `redirects` (`from_path`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`translation_id` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`subtitle` text DEFAULT '' NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`cover` text DEFAULT '' NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`front_matter` text DEFAULT '' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`kind` text DEFAULT 'auto' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`author_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`translation_id`) REFERENCES `post_translations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `revisions_translation` ON `revisions` (`translation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);