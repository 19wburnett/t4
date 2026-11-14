import {
  CompanyBrainCollection,
  CompanyBrainCollectionId,
  CompanyBrainFields,
  CompanyBrainRecord,
  CompanyBrainRecordId,
  CompanyBrainRecordSummary,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CompanyBrain from "../../../companyBrain/CompanyBrain.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../../provider/ProviderInstanceRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderInstanceRegistry.ProviderInstanceRegistry,
    CompanyBrain.CompanyBrain,
  ],
};
const projectId = Schema.optional(ProjectId).annotate({
  description: "The company's project. Defaults to your thread's.",
});

const CompanyBrainFindTool = Tool.make("t3_brain_find", {
  ...shared,
  description:
    "Look up the company's records: people, companies, deals, investors, candidates, and notes kept in company/. Without collection, lists the collections. With collection, lists its records, filtered by query against names and fields. With recordId, returns that record with its notes.",
  parameters: Schema.Struct({
    projectId,
    collection: Schema.optional(CompanyBrainCollectionId),
    recordId: Schema.optional(CompanyBrainRecordId),
    query: Schema.optional(TrimmedNonEmptyString),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    collections: Schema.Array(CompanyBrainCollection),
    records: Schema.Array(CompanyBrainRecordSummary),
    record: Schema.NullOr(CompanyBrainRecord),
  }),
}).annotate(Tool.Destructive, false);

const CompanyBrainSaveTool = Tool.make("t3_brain_save", {
  ...shared,
  description:
    "Create or update a company record. Without recordId, creates one named title. set changes only the fields you pass; note logs what happened (a call, an email sent, a next step) at the top of the record's log. A new collection name creates that collection.",
  parameters: Schema.Struct({
    projectId,
    collection: CompanyBrainCollectionId,
    recordId: Schema.optional(CompanyBrainRecordId),
    title: Schema.optional(TrimmedNonEmptyString),
    set: Schema.optional(CompanyBrainFields).annotate({
      description: 'Fields to add or change, such as { stage: "meeting", email: "ada@acme.com" }.',
    }),
    unset: Schema.optional(Schema.Array(Schema.String)),
    body: Schema.optional(Schema.String).annotate({
      description: "Replaces the record's whole Markdown text, including its log.",
    }),
    note: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    collection: CompanyBrainCollectionId,
    id: CompanyBrainRecordId,
    path: Schema.String,
    title: Schema.String,
  }),
}).annotate(Tool.Destructive, false);

export const CompanyBrainToolkit = Toolkit.make(CompanyBrainFindTool, CompanyBrainSaveTool);
