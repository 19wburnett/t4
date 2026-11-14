import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  CompanyBrainFields,
  CompanyBrainRecordId,
  CompanyBrainRecordSummary,
} from "@t3tools/contracts";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "../settings/pairingUrls";
import { type Employee, textField } from "./companyTeam.logic";

/** Teammates are brain records too, so every machine that syncs the brain sees the same roster. */
export const MEMBERS_COLLECTION = "members";

export const MEMBERS_COLLECTION_LABEL = "People";

export const MEMBERS_DESCRIPTION =
  "The people on this company. One file per teammate, with their email and role.";

export type MemberRole = "admin" | "member";

export interface Member {
  readonly recordId: CompanyBrainRecordId;
  readonly name: string;
  readonly email: string;
  readonly role: MemberRole;
}

export function memberFromRecord(record: CompanyBrainRecordSummary): Member {
  return {
    recordId: record.id,
    name: record.title,
    email: textField(record.fields, "email"),
    role: textField(record.fields, "role") === "admin" ? "admin" : "member",
  };
}

export const memberFields = (input: {
  readonly email: string;
  readonly role: MemberRole;
}): CompanyBrainFields => ({
  kind: "member",
  email: input.email.trim(),
  role: input.role,
});

/** The hosted app when the machine is reachable over HTTPS, else the machine's own page. */
export function memberInviteUrl(host: string, credential: string): string {
  return resolveHostedPairingUrl(host, credential) ?? resolveDesktopPairingUrl(host, credential);
}

export type ActivityView = "everyone" | "person" | "employee" | "project";

/** Who an activity row is about: a teammate, the owner (no member), or an AI employee. */
export type ActivityActor =
  | { readonly kind: "owner" }
  | { readonly kind: "member"; readonly member: Member }
  | { readonly kind: "employee"; readonly employee: Employee };

export type ThreadActivity = "approval" | "input" | "working" | "failed" | "idle";

export function threadActivity(thread: EnvironmentThreadShell): ThreadActivity {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  const status = thread.runtime?.status ?? "idle";
  if (status === "failed") return "failed";
  return status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
    ? "working"
    : "idle";
}

export const THREAD_ACTIVITY_LABELS: Record<ThreadActivity, string> = {
  approval: "Needs approval",
  input: "Waiting for an answer",
  working: "Working",
  failed: "Failed",
  idle: "Idle",
};

/** Top-level, live threads, newest first; subagents show through their parent. */
function activityThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.source.deletedAt === null &&
        thread.source.lineage.relationshipToParent !== "subagent",
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** What decides who a thread is for: the roster, and whose own machine each machine is. */
export interface Credit {
  readonly members: ReadonlyArray<Member>;
  /** Environment id to the teammate whose own machine it is. */
  readonly machineOwners: ReadonlyMap<string, string>;
}

/**
 * The teammate a thread is for: whoever's session started it, else whose own machine it is on.
 * `null` is the owner, including a starter no longer on the roster. The server's
 * `t3_team_activity` credits threads the same way.
 */
function starterOf(thread: EnvironmentThreadShell, credit: Credit): string | null {
  const starter = thread.source.memberId ?? credit.machineOwners.get(thread.environmentId) ?? null;
  return starter !== null && credit.members.some((member) => member.recordId === starter)
    ? starter
    : null;
}

/** The AI employee a thread works as: its bot. */
const threadEmployeeId = (thread: EnvironmentThreadShell) => thread.source.bot ?? null;

export interface ActorSummary {
  readonly key: string;
  readonly actor: ActivityActor;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Threads that are working, failed, or waiting on someone. */
  readonly active: number;
  readonly latest: EnvironmentThreadShell | null;
}

const summarize = (
  key: string,
  actor: ActivityActor,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ActorSummary => ({
  key,
  actor,
  threads,
  active: threads.filter((thread) => threadActivity(thread) !== "idle").length,
  latest: threads[0] ?? null,
});

/** `null` is the owner. */
export function personThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  memberId: string | null,
  credit: Credit,
): ReadonlyArray<EnvironmentThreadShell> {
  return activityThreads(threads).filter((thread) => starterOf(thread, credit) === memberId);
}

export function employeeThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  employeeId: string,
): ReadonlyArray<EnvironmentThreadShell> {
  return activityThreads(threads).filter((thread) => threadEmployeeId(thread) === employeeId);
}

/** `projectKey` is `<environmentId>:<projectId>`: project ids are only unique per machine. */
export function projectThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projectKey: string,
): ReadonlyArray<EnvironmentThreadShell> {
  return activityThreads(threads).filter(
    (thread) => `${thread.environmentId}:${thread.projectId}` === projectKey,
  );
}

/**
 * One card per person and AI employee. A thread counts for whoever started it and, when an
 * employee does the work, for that employee too. Everyone listed shows, even with no work yet.
 */
export function everyoneSummaries(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly credit: Credit;
  readonly employees: ReadonlyArray<Employee>;
}): ReadonlyArray<ActorSummary> {
  // Filter and sort once; every card then picks its threads from the same list.
  const live = activityThreads(input.threads);
  const startedBy = (memberId: string | null) =>
    live.filter((thread) => starterOf(thread, input.credit) === memberId);
  return [
    summarize("owner", { kind: "owner" }, startedBy(null)),
    ...input.credit.members.map((member) =>
      summarize(
        `member:${member.recordId}`,
        { kind: "member", member },
        startedBy(member.recordId),
      ),
    ),
    ...input.employees.map((employee) =>
      summarize(
        `employee:${employee.recordId}`,
        { kind: "employee", employee },
        live.filter((thread) => threadEmployeeId(thread) === employee.recordId),
      ),
    ),
  ];
}

/** Who started a thread, for lists that mix people. */
export function threadStarterName(
  thread: EnvironmentThreadShell,
  credit: Credit,
  ownerLabel: string,
): string {
  const memberId = starterOf(thread, credit);
  return credit.members.find((member) => member.recordId === memberId)?.name ?? ownerLabel;
}
