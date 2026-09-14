-- The DDL the deploy applies. Generated from src/server/schema.ts and kept in
-- sync with it — schema.ts types the queries, this file is what actually
-- reaches D1.
--
-- It exists because `clawnify deploy` reconciles THIS file and nothing else:
-- applyPendingMigrations (which reads drizzle/) runs only on the agent build
-- path. Without a schema.sql, a CLI deploy applied no schema change at all,
-- and the failure was silent in the worst way — SQLite returns a double-quoted
-- identifier as a string literal, so a column that did not exist came back as
-- its own name on every row rather than raising.
--
-- Reconcile is additive: it adds missing columns and never drops anything, so
-- regenerating this file is safe against a live database.

CREATE TABLE IF NOT EXISTS `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel` text NOT NULL,
	`handle` text NOT NULL,
	`name` text,
	`profile_name` text,
	`avatar_url` text,
	`linked_app_id` text,
	`linked_ref` text,
	`created_at` text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `contacts_by_org_channel_handle` ON `contacts` (`org_id`,`channel`,`handle`);
CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`channel` text NOT NULL,
	`subject` text,
	`status` text DEFAULT 'open' NOT NULL,
	`unread` integer DEFAULT 0 NOT NULL,
	`last_message_at` text NOT NULL,
	`last_message_preview` text DEFAULT '' NOT NULL,
	`assignee_id` text,
	`assignee_name` text,
	`created_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `conversations_by_org_recency` ON `conversations` (`org_id`,`last_message_at`);
CREATE INDEX IF NOT EXISTS `conversations_by_org_assignee` ON `conversations` (`org_id`,`assignee_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `conversations_by_org_contact` ON `conversations` (`org_id`,`contact_id`);
CREATE TABLE IF NOT EXISTS `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`author_name` text,
	`user_id` text,
	`status` text,
	`error` text,
	`external_id` text,
	`media_ref` text,
	`media_type` text,
	`media_key` text,
	`media_mime` text,
	`media_name` text,
	`template_name` text,
	`template_language` text,
	`template_variables` text,
	`created_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `messages_by_conversation` ON `messages` (`conversation_id`,`created_at`);
CREATE UNIQUE INDEX IF NOT EXISTS `messages_by_org_external` ON `messages` (`org_id`,`external_id`);
CREATE INDEX IF NOT EXISTS `messages_by_org_status` ON `messages` (`org_id`,`status`);
CREATE TABLE IF NOT EXISTS `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `settings_by_org_key` ON `settings` (`org_id`,`key`);
CREATE TABLE IF NOT EXISTS `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel` text NOT NULL,
	`name` text NOT NULL,
	`language` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`components` text DEFAULT '[]' NOT NULL,
	`external_id` text,
	`synced_at` text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `templates_by_org_channel_name_language` ON `templates` (`org_id`,`channel`,`name`,`language`);
CREATE INDEX IF NOT EXISTS `templates_by_org_channel` ON `templates` (`org_id`,`channel`,`status`);
