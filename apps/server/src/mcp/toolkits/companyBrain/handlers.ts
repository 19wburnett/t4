import {
  CompanyBrainCollectionId,
  type CompanyBrainError,
  type CompanyBrainRecordSummary,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CompanyBrain from "../../../companyBrain/CompanyBrain.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerLabel, companyProject } from "../companyChannels/handlers.ts";
import { CompanyBrainToolkit, TeamActivityTool } from "./tools.ts";

const DEFAULT_LIMIT = 25;

const byNewest = (left: { readonly updatedAt: string }, right: { readonly updatedAt: string }) =>
  right.updatedAt.localeCompare(left.updatedAt);

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
const MACHINE_THREADS = 50;
const REMOTE_TIMEOUT = Duration.seconds(5);
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export interface Roster {
  readonly members: ReadonlyArray<CompanyBrainRecordSummary>;
  readonly employees: ReadonlyArray<CompanyBrainRecordSummary>;
  /** Company machines other than this one, and the teammate whose own machine each is. */
  readonly machines: ReadonlyArray<{
    readonly name: string;
    readonly environmentId: EnvironmentId;
    readonly ownerMemberId: string | null;
  }>;
}

const EMPTY_ROSTER: Roster = { members: [], employees: [], machines: [] };

const textField = (record: CompanyBrainRecordSummary, key: string) => {
  const value = record.fields[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

/** A company without a people, team or machine list yet simply has nobody in it. */
const rosterOf = Effect.fn("mcp.teamActivity.roster")(function* (
  projectId: ProjectId,
  here: EnvironmentId,
) {
  const brain = yield* CompanyBrain.CompanyBrain;
  const records = (collection: string) =>
    brain.listRecords({ projectId, collection: CompanyBrainCollectionId.make(collection) }).pipe(
      Effect.map((listing) => listing.records),
      Effect.orElseSucceed((): ReadonlyArray<CompanyBrainRecordSummary> => []),
    );
  return {
    members: yield* records("members"),
    employees: yield* records("agents"),
    machines: (yield* records("machines")).flatMap((record) => {
      const environmentId = textField(record, "environmentId");
      return environmentId === null || environmentId === here
        ? []
        : [
            {
              name: record.title,
              environmentId: EnvironmentId.make(environmentId),
              ownerMemberId: textField(record, "ownerMemberId"),
            },
          ];
    }),
  } satisfies Roster;
});

/** One thread as the tool reports it, before names are resolved against a roster. */
export interface ActivityRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly status: string;
  readonly waitingOn: "approval" | "answer" | null;
  readonly memberId: string | null;
  readonly employeeId: string | null;
  readonly updatedAt: string;
}

const rowOf = (environmentId: EnvironmentId, thread: OrchestrationV2ThreadShell): ActivityRow => ({
  threadId: thread.id,
  title: thread.title,
  environmentId,
  projectId: thread.projectId,
  status: thread.status,
  waitingOn:
    thread.pendingRuntimeRequest === null
      ? null
      : thread.pendingRuntimeRequest.kind === "user_input" ||
          thread.pendingRuntimeRequest.kind === "mcp-elicitation"
        ? "answer"
        : "approval",
  memberId: thread.memberId ?? null,
  employeeId: thread.employeeId ?? null,
  updatedAt: DateTime.formatIso(thread.updatedAt),
});

const isActive = (row: ActivityRow) => ACTIVE_STATUSES.has(row.status) || row.waitingOn !== null;

/**
 * Who a row is for: the teammate whose session started it, else the teammate whose own machine
 * it is on, else the owner (`null`). A starter no longer on the roster counts as the owner.
 */
export const starterOf = (roster: Roster) => {
  const known = new Set<string>(roster.members.map((member) => member.id));
  const owners = new Map(
    roster.machines.map((machine) => [machine.environmentId as string, machine.ownerMemberId]),
  );
  return (row: ActivityRow) => {
    const starter = row.memberId ?? owners.get(row.environmentId) ?? null;
    return starter !== null && known.has(starter) ? starter : null;
  };
};

const present = (row: ActivityRow, roster: Roster, starter: string | null) => ({
  ...row,
  memberId: starter,
  startedBy: roster.members.find((member) => member.id === starter)?.title ?? "Owner",
  employee:
    row.employeeId === null
      ? null
      : (roster.employees.find((employee) => employee.id === row.employeeId)?.title ??
        row.employeeId),
});

const localRows = Effect.fn("mcp.teamActivity.localRows")(function* (here: EnvironmentId) {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const threads = yield* threadManagement
    .listProjectThreads({ includeSubagents: false })
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  return threads
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .map((thread) => rowOf(here, thread));
});

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
  t3_team_activity: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const here = scope.environmentId;
      const limit = input.limit ?? DEFAULT_LIMIT;

      // Another company machine asks this for its threads; this one need not know the company.
      if (input.view === "machine") {
        const roster = yield* companyProject(input.projectId).pipe(
          Effect.flatMap(({ projectId }) => rosterOf(projectId, here)),
          Effect.orElseSucceed(() => EMPTY_ROSTER),
        );
        const starter = starterOf(roster);
        const rows = (yield* localRows(here)).toSorted(byNewest).slice(0, limit);
        return {
          groups: [
            {
              kind: "machine" as const,
              id: here,
              name: "This machine",
              active: rows.filter(isActive).length,
              // Raw ids: the asking machine resolves them against its own roster.
              threads: rows.map((row) => ({
                ...present(row, roster, starter(row)),
                memberId: row.memberId,
              })),
            },
          ],
          unreachable: [],
        };
      }

      const { projectId } = yield* companyProject(input.projectId);
      const roster = yield* rosterOf(projectId, here);
      const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
      // Machines are read at once, each with a deadline, so one offline machine costs seconds.
      const remotes = yield* Effect.forEach(
        roster.machines,
        (machine) =>
          (Option.isNone(forwarding)
            ? Effect.succeedNone
            : forwarding.value
                .call(scope, TeamActivityTool, machine.environmentId, {
                  environmentId: machine.environmentId,
                  view: "machine",
                  limit: MACHINE_THREADS,
                })
                .pipe(Effect.timeout(REMOTE_TIMEOUT), Effect.option)
          ).pipe(Effect.map((result) => ({ machine, result }))),
        { concurrency: "unbounded" },
      );
      const unreachable = remotes.flatMap(({ machine, result }) =>
        Option.isNone(result) ? [machine.name] : [],
      );
      const rows: Array<ActivityRow> = [...(yield* localRows(here))];
      for (const { machine, result } of remotes) {
        if (Option.isNone(result)) continue;
        for (const group of result.value.groups) {
          for (const thread of group.threads) {
            rows.push({ ...thread, environmentId: machine.environmentId });
          }
        }
      }
      const sorted = rows.toSorted(byNewest);
      const starter = starterOf(roster);
      const group = (
        kind: "owner" | "member" | "employee" | "project",
        id: string | null,
        name: string,
        matching: ReadonlyArray<ActivityRow>,
        count: number,
      ) => ({
        kind,
        id,
        name,
        active: matching.filter(isActive).length,
        threads: matching.slice(0, count).map((row) => present(row, roster, starter(row))),
      });
      const startedBy = (memberId: string | null) =>
        sorted.filter((row) => starter(row) === memberId);
      const forEmployee = (employeeId: string) =>
        sorted.filter((row) => row.employeeId === employeeId);

      switch (input.view) {
        case "everyone":
          return {
            groups: [
              group("owner", null, "Owner", startedBy(null), EVERYONE_THREADS),
              ...roster.members.map((member) =>
                group("member", member.id, member.title, startedBy(member.id), EVERYONE_THREADS),
              ),
              ...roster.employees.map((employee) =>
                group(
                  "employee",
                  employee.id,
                  employee.title,
                  forEmployee(employee.id),
                  EVERYONE_THREADS,
                ),
              ),
            ],
            unreachable,
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
                ? group("owner", null, "Owner", startedBy(null), limit)
                : group("member", member.id, member.title, startedBy(member.id), limit),
            ],
            unreachable,
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
              group("employee", employee.id, employee.title, forEmployee(employee.id), limit),
            ],
            unreachable,
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
                sorted.filter((row) => row.projectId === workProjectId),
                limit,
              ),
            ],
            unreachable,
          };
        }
      }
    }),
  ),
});
