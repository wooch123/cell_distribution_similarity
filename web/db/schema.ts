import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sharedTrainingSamples = sqliteTable(
  "shared_training_samples",
  {
    id: text("id").primaryKey(),
    fingerprint: text("fingerprint").notNull(),
    label: text("label").notNull(),
    imageKey: text("image_key").notNull(),
    imageMime: text("image_mime").notNull().default("image/svg+xml"),
    sourceImageKey: text("source_image_key"),
    sourceImageMime: text("source_image_mime"),
    profileJson: text("profile_json").notNull(),
    descriptorJson: text("descriptor_json").notNull(),
    stateCount: integer("state_count").notNull(),
    contributorHash: text("contributor_hash").notNull(),
    deletionHash: text("deletion_hash").notNull(),
    status: text("status").notNull().default("active"),
    consentVersion: text("consent_version").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("shared_training_samples_fingerprint_idx").on(
      table.fingerprint,
    ),
    index("shared_training_samples_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("shared_training_samples_contributor_created_idx").on(
      table.contributorHash,
      table.createdAt,
    ),
  ],
);

export const sharedRelevanceReports = sqliteTable(
  "shared_relevance_reports",
  {
    id: text("id").primaryKey(),
    queryHash: text("query_hash").notNull(),
    queryShapeFingerprint: text("query_shape_fingerprint").notNull(),
    annotatorHash: text("annotator_hash").notNull(),
    reportJson: text("report_json").notNull(),
    judgmentCount: integer("judgment_count").notNull(),
    similarCount: integer("similar_count").notNull(),
    dissimilarCount: integer("dissimilar_count").notNull(),
    contributorHash: text("contributor_hash").notNull(),
    deletionHash: text("deletion_hash").notNull(),
    status: text("status").notNull().default("active"),
    consentVersion: text("consent_version").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("shared_relevance_query_annotator_idx").on(
      table.queryHash,
      table.annotatorHash,
    ),
    index("shared_relevance_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("shared_relevance_contributor_created_idx").on(
      table.contributorHash,
      table.createdAt,
    ),
    index("shared_relevance_shape_idx").on(table.queryShapeFingerprint),
  ],
);
