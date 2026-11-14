import {
  type CompanyBrainError,
  type CompanyBrainRecordSummary,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CompanyBrain from "../../../companyBrain/CompanyBrain.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerLabel, companyProject } from "../companyChannels/handlers.ts";
import { CompanyBrainToolkit } from "./tools.ts";

const DEFAULT_LIMIT = 25;

const failure = (error: CompanyBrainError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const matches = (record: CompanyBrainRecordSummary, query: string) => {
  const needle = query.toLowerCase();
  return (
    record.title.toLowerCase().includes(needle) ||
    JSON.stringify(record.fields).toLowerCase().includes(needle)
  );
};

export const layer = McpToolAccess.toLayer(CompanyBrainToolkit, {
  t3_brain_find: McpToolAccess.readsPrivate((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* companyProject(input.projectId);
      const brain = yield* CompanyBrain.CompanyBrain;
      if (input.collection === undefined) {
        const { collections } = yield* brain.listCollections(projectId);
        return { collections, records: [], record: null };
      }
      if (input.recordId !== undefined) {
        const record = yield* brain.readRecord({
          projectId,
          collection: input.collection,
          recordId: input.recordId,
        });
        return { collections: [], records: [], record };
      }
      const listing = yield* brain.listRecords({ projectId, collection: input.collection });
      const query = input.query;
      const found =
        query === undefined ? listing.records : listing.records.filter((r) => matches(r, query));
      return {
        collections: [listing.collection],
        records: found.slice(0, input.limit ?? DEFAULT_LIMIT),
        record: null,
      };
    }).pipe(Effect.catchTags({ CompanyBrainError: (error) => Effect.fail(failure(error)) })),
  ),
  t3_brain_save: McpToolAccess.writesWithCapability(({ projectId: requested, ...input }) =>
    Effect.gen(function* () {
      const { caller, projectId } = yield* companyProject(requested);
      const brain = yield* CompanyBrain.CompanyBrain;
      const record = yield* brain.saveRecord({
        projectId,
        author: yield* callerLabel(caller),
        collection: input.collection,
        ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.set === undefined ? {} : { set: input.set }),
        ...(input.unset === undefined ? {} : { unset: input.unset }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return {
        collection: record.collection,
        id: record.id,
        path: record.path,
        title: record.title,
      };
    }).pipe(Effect.catchTags({ CompanyBrainError: (error) => Effect.fail(failure(error)) })),
  ),
});
