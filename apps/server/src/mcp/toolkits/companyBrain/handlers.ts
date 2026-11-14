import {
  CompanyBrainCollectionId,
  type CompanyBrainError,
  type CompanyBrainRecordSummary,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as CompanyBrain from "../../../companyBrain/CompanyBrain.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
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

const EVERYONE_THREADS = 3;
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

interface Roster {
  readonly members: ReadonlyArray<CompanyBrainRecordSummary>;
  readonly employees: ReadonlyArray<CompanyBrainRecordSummary>;
}

/** A company without a people or team list yet simply has nobody in it. */
const rosterOf = Effect.fn("mcp.teamActivity.roster")(function* (projectId: ProjectId) {
  const brain = yield* CompanyBrain.CompanyBrain;
  const records = (collection: string) =>
    brain.listRecords({ projectId, collection: CompanyBrainCollectionId.make(collection) }).pipe(
      Effect.map((listing) => listing.records),
      Effect.orElseSucceed((): ReadonlyArray<CompanyBrainRecordSummary> => []),
    );
  return {
    members: yield* records("members"),
    employees: yield* records("agents"),
  } satisfies Roster;
});

const activityRow = (thread: OrchestrationV2ThreadShell, roster: Roster) => ({
  threadId: thread.id,
  title: thread.title,
  projectId: thread.projectId,
  status: thread.status,
  waitingOn:
    thread.pendingRuntimeRequest === null
      ? null
      : thread.pendingRuntimeRequest.kind === "user_input" ||
          thread.pendingRuntimeRequest.kind === "mcp-elicitation"
        ? ("answer" as const)
        : ("approval" as const),
  startedBy: roster.members.find((member) => member.id === thread.memberId)?.title ?? "Owner",
  employee:
    thread.employeeId === undefined
      ? null
      : (roster.employees.find((employee) => employee.id === thread.employeeId)?.title ??
        thread.employeeId),
  updatedAt: DateTime.formatIso(thread.updatedAt),
});

const isActive = (thread: OrchestrationV2ThreadShell) =>
  ACTIVE_STATUSES.has(thread.status) || thread.pendingRuntimeRequest !== null;

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
  t3_team_activity: McpToolAccess.readsPrivate((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* companyProject(input.projectId);
      const roster = yield* rosterOf(projectId);
      const threadManagement = yield* ThreadManagementService.ThreadManagementService;
      const threads = (yield* threadManagement
        .listProjectThreads({ includeSubagents: false })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        ))
        .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        );
      const known = new Set<string>(roster.members.map((member) => member.id));
      const startedByOwner = (thread: OrchestrationV2ThreadShell) =>
        thread.memberId === undefined || !known.has(thread.memberId);
      const group = (
        kind: "owner" | "member" | "employee" | "project",
        id: string | null,
        name: string,
        matching: ReadonlyArray<OrchestrationV2ThreadShell>,
        limit: number,
      ) => ({
        kind,
        id,
        name,
        active: matching.filter(isActive).length,
        threads: matching.slice(0, limit).map((thread) => activityRow(thread, roster)),
      });
      const limit = input.limit ?? DEFAULT_LIMIT;
      switch (input.view) {
        case "everyone":
          return {
            groups: [
              group("owner", null, "Owner", threads.filter(startedByOwner), EVERYONE_THREADS),
              ...roster.members.map((member) =>
                group(
                  "member",
                  member.id,
                  member.title,
                  threads.filter((thread) => thread.memberId === member.id),
                  EVERYONE_THREADS,
                ),
              ),
              ...roster.employees.map((employee) =>
                group(
                  "employee",
                  employee.id,
                  employee.title,
                  threads.filter((thread) => thread.employeeId === employee.id),
                  EVERYONE_THREADS,
                ),
              ),
            ],
          };
        case "person": {
          const member = roster.members.find((entry) => entry.id === input.memberId);
          if (input.memberId !== undefined && member === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `No teammate ${input.memberId}. View everyone to see their ids.`,
            });
          }
          return {
            groups: [
              member === undefined
                ? group("owner", null, "Owner", threads.filter(startedByOwner), limit)
                : group(
                    "member",
                    member.id,
                    member.title,
                    threads.filter((thread) => thread.memberId === member.id),
                    limit,
                  ),
            ],
          };
        }
        case "employee": {
          const employee = roster.employees.find((entry) => entry.id === input.employeeId);
          if (employee === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "Pass employeeId. View everyone to see the AI employees and their ids.",
            });
          }
          return {
            groups: [
              group(
                "employee",
                employee.id,
                employee.title,
                threads.filter((thread) => thread.employeeId === employee.id),
                limit,
              ),
            ],
          };
        }
        case "project": {
          const workProjectId = input.workProjectId ?? projectId;
          return {
            groups: [
              group(
                "project",
                workProjectId,
                workProjectId,
                threads.filter((thread) => thread.projectId === workProjectId),
                limit,
              ),
            ],
          };
        }
      }
    }),
  ),
});
