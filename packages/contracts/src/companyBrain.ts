import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A company's records: every folder in `company/` except `outbox` is a
 * collection, and every Markdown file in it is a record whose frontmatter holds
 * its fields. Brains kept in Obsidian or a GitHub repo already look like this,
 * so names are whatever the folder and file are called, not slugs.
 */
const BrainName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[^./\\\u0000][^/\\\u0000]*$/),
);

export const CompanyBrainCollectionId = BrainName.pipe(Schema.brand("CompanyBrainCollectionId"));
export type CompanyBrainCollectionId = typeof CompanyBrainCollectionId.Type;

/** The record's file name without `.md`. */
export const CompanyBrainRecordId = BrainName.pipe(Schema.brand("CompanyBrainRecordId"));
export type CompanyBrainRecordId = typeof CompanyBrainRecordId.Type;

export const CompanyBrainFields = Schema.Record(Schema.String, Schema.Json);
export type CompanyBrainFields = typeof CompanyBrainFields.Type;

/** Configured by the folder's optional `README.md`: its frontmatter, and its text as the description. */
export const CompanyBrainCollection = Schema.Struct({
  id: CompanyBrainCollectionId,
  label: Schema.String,
  description: Schema.String,
  /** The field a pipeline board groups by. */
  stageField: Schema.String,
  /** Board columns in order; empty when the collection is a plain list. */
  stages: Schema.Array(Schema.String),
  recordCount: Schema.Int,
});
export type CompanyBrainCollection = typeof CompanyBrainCollection.Type;

export const CompanyBrainMalformedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  message: Schema.String,
});
export type CompanyBrainMalformedFile = typeof CompanyBrainMalformedFile.Type;

export const CompanyBrainCollectionList = Schema.Struct({
  collections: Schema.Array(CompanyBrainCollection),
  malformed: Schema.Array(CompanyBrainMalformedFile),
});
export type CompanyBrainCollectionList = typeof CompanyBrainCollectionList.Type;

export const CompanyBrainRecordSummary = Schema.Struct({
  collection: CompanyBrainCollectionId,
  id: CompanyBrainRecordId,
  /** Relative to the project folder. */
  path: TrimmedNonEmptyString,
  /** The `name` or `title` field, else the file name. */
  title: Schema.String,
  fields: CompanyBrainFields,
  updatedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type CompanyBrainRecordSummary = typeof CompanyBrainRecordSummary.Type;

export const CompanyBrainRecord = Schema.Struct({
  ...CompanyBrainRecordSummary.fields,
  body: Schema.String,
});
export type CompanyBrainRecord = typeof CompanyBrainRecord.Type;

export const CompanyBrainRecordList = Schema.Struct({
  collection: CompanyBrainCollection,
  /** Most recently changed first. */
  records: Schema.Array(CompanyBrainRecordSummary),
  /** Field names across the records, most used first. */
  fields: Schema.Array(Schema.String),
  /** More records exist than one listing returns. */
  truncated: Schema.Boolean,
  malformed: Schema.Array(CompanyBrainMalformedFile),
});
export type CompanyBrainRecordList = typeof CompanyBrainRecordList.Type;

export const CompanyBrainProjectInput = Schema.Struct({ projectId: ProjectId });
export type CompanyBrainProjectInput = typeof CompanyBrainProjectInput.Type;

export const CompanyBrainCollectionInput = Schema.Struct({
  projectId: ProjectId,
  collection: CompanyBrainCollectionId,
});
export type CompanyBrainCollectionInput = typeof CompanyBrainCollectionInput.Type;

export const CompanyBrainRecordInput = Schema.Struct({
  projectId: ProjectId,
  collection: CompanyBrainCollectionId,
  recordId: CompanyBrainRecordId,
});
export type CompanyBrainRecordInput = typeof CompanyBrainRecordInput.Type;

export const CompanyBrainRecordSaveInput = Schema.Struct({
  projectId: ProjectId,
  collection: CompanyBrainCollectionId,
  /** Omitted to create a record, named after `title`. */
  recordId: Schema.optionalKey(CompanyBrainRecordId),
  /** Saved as the `name` field. Required to create a record. */
  title: Schema.optionalKey(TrimmedNonEmptyString),
  /** Fields to add or change; others are kept. */
  set: Schema.optionalKey(CompanyBrainFields),
  unset: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Replaces the Markdown body. */
  body: Schema.optionalKey(Schema.String),
  /** Added to the top of the record's `## Log`, dated and signed. */
  note: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CompanyBrainRecordSaveInput = typeof CompanyBrainRecordSaveInput.Type;

export const CompanyBrainRecordDeleteResult = Schema.Struct({ deleted: Schema.Boolean });
export type CompanyBrainRecordDeleteResult = typeof CompanyBrainRecordDeleteResult.Type;

/** Creates the folder, or changes what its `README.md` says about it. */
export const CompanyBrainCollectionSaveInput = Schema.Struct({
  projectId: ProjectId,
  collection: CompanyBrainCollectionId,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  description: Schema.optionalKey(Schema.String),
  stages: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type CompanyBrainCollectionSaveInput = typeof CompanyBrainCollectionSaveInput.Type;

/** Where `company/` lives: only in this folder, or in a git repo it syncs with. */
export const CompanyBrainSource = Schema.Union([
  Schema.TaggedStruct("local", {}),
  Schema.TaggedStruct("git", {
    /** Without credentials. */
    remoteUrl: Schema.String,
    branch: Schema.NullOr(Schema.String),
    /** Files changed here since the last sync. */
    changes: Schema.Int,
    /** Commits not pushed yet, and commits the last fetch saw upstream. */
    ahead: Schema.Int,
    behind: Schema.Int,
  }),
]);
export type CompanyBrainSource = typeof CompanyBrainSource.Type;

export const CompanyBrainConnectInput = Schema.Struct({
  projectId: ProjectId,
  /** `owner/repo`, a GitHub URL, or any git clone URL. */
  repository: TrimmedNonEmptyString,
});
export type CompanyBrainConnectInput = typeof CompanyBrainConnectInput.Type;

export const CompanyBrainConnectResult = Schema.Struct({
  source: CompanyBrainSource,
  /** Files only this folder had, now in the repo's folder and synced next time. */
  kept: Schema.Int,
  /** Where this folder's versions of files the repo also has were saved; null when none differed. */
  backupPath: Schema.NullOr(Schema.String),
});
export type CompanyBrainConnectResult = typeof CompanyBrainConnectResult.Type;

export const CompanyBrainFailure = Schema.Literals([
  "unknown_project",
  "unknown_collection",
  "unknown_record",
  "invalid_input",
  "malformed",
  "storage",
  "not_connected",
  "already_connected",
  "conflict",
  "git_failed",
]);
export type CompanyBrainFailure = typeof CompanyBrainFailure.Type;

export class CompanyBrainError extends Schema.TaggedError<CompanyBrainError>()(
  "CompanyBrainError",
  {
    reason: CompanyBrainFailure,
    message: Schema.String,
  },
) {}
