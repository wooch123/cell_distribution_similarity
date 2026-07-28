CREATE TABLE `shared_training_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`label` text NOT NULL,
	`image_key` text NOT NULL,
	`image_mime` text DEFAULT 'image/svg+xml' NOT NULL,
	`profile_json` text NOT NULL,
	`descriptor_json` text NOT NULL,
	`state_count` integer NOT NULL,
	`contributor_hash` text NOT NULL,
	`deletion_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`consent_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_training_samples_fingerprint_idx` ON `shared_training_samples` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `shared_training_samples_status_created_idx` ON `shared_training_samples` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `shared_training_samples_contributor_created_idx` ON `shared_training_samples` (`contributor_hash`,`created_at`);