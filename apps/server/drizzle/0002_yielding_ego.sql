CREATE TABLE `ui_translations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`locale` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ui_translations_pk` ON `ui_translations` (`locale`,`key`);--> statement-breakpoint
ALTER TABLE `post_translations` ADD `source_translation_id` integer;--> statement-breakpoint
ALTER TABLE `post_translations` ADD `source_revision_id` integer;