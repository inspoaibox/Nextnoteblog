CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`visible` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_parent` ON `categories` (`parent_id`,`sort`);--> statement-breakpoint
CREATE TABLE `category_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`locale` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`seo_title` text DEFAULT '' NOT NULL,
	`seo_description` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_translations_cat_locale` ON `category_translations` (`category_id`,`locale`);--> statement-breakpoint
CREATE TABLE `collection_items` (
	`collection_id` integer NOT NULL,
	`post_id` integer NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_items_pk` ON `collection_items` (`collection_id`,`post_id`);--> statement-breakpoint
CREATE INDEX `collection_items_post` ON `collection_items` (`post_id`);--> statement-breakpoint
CREATE TABLE `collection_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`locale` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_translations_col_locale` ON `collection_translations` (`collection_id`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `collection_translations_locale_slug` ON `collection_translations` (`locale`,`slug`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`cover` text DEFAULT '' NOT NULL,
	`visible` integer DEFAULT 1 NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nav_item_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`nav_item_id` integer NOT NULL,
	`locale` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`nav_item_id`) REFERENCES `nav_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nav_item_translations_pk` ON `nav_item_translations` (`nav_item_id`,`locale`);--> statement-breakpoint
CREATE TABLE `nav_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`menu` text NOT NULL,
	`parent_id` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`type` text NOT NULL,
	`target_id` integer,
	`url` text DEFAULT '' NOT NULL,
	`new_tab` integer DEFAULT 0 NOT NULL,
	`visible` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nav_items_menu` ON `nav_items` (`menu`,`sort`);--> statement-breakpoint
CREATE TABLE `page_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` integer NOT NULL,
	`locale` text NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`seo_description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_title` text DEFAULT '' NOT NULL,
	`published_markdown` text DEFAULT '' NOT NULL,
	`published_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_translations_page_locale` ON `page_translations` (`page_id`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `page_translations_locale_slug` ON `page_translations` (`locale`,`slug`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_categories` (
	`post_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`is_primary` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_categories_pk` ON `post_categories` (`post_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `post_categories_cat` ON `post_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `post_tags` (
	`post_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_tags_pk` ON `post_tags` (`post_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `post_tags_tag` ON `post_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `search_terms` (
	`term` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`results` integer DEFAULT 0 NOT NULL,
	`last_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tag_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tag_id` integer NOT NULL,
	`locale` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_translations_tag_locale` ON `tag_translations` (`tag_id`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `tag_translations_locale_slug` ON `tag_translations` (`locale`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `tag_translations_locale_name` ON `tag_translations` (`locale`,`name`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL
);
