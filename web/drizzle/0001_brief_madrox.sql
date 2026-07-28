CREATE TABLE `shared_relevance_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`query_hash` text NOT NULL,
	`query_shape_fingerprint` text NOT NULL,
	`annotator_hash` text NOT NULL,
	`report_json` text NOT NULL,
	`judgment_count` integer NOT NULL,
	`similar_count` integer NOT NULL,
	`dissimilar_count` integer NOT NULL,
	`contributor_hash` text NOT NULL,
	`deletion_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`consent_version` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_relevance_query_annotator_idx` ON `shared_relevance_reports` (`query_hash`,`annotator_hash`);--> statement-breakpoint
CREATE INDEX `shared_relevance_status_created_idx` ON `shared_relevance_reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `shared_relevance_contributor_created_idx` ON `shared_relevance_reports` (`contributor_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `shared_relevance_shape_idx` ON `shared_relevance_reports` (`query_shape_fingerprint`);