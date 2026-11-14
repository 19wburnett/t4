import { companyMemberIdFromSubject } from "@t3tools/contracts";
import type {
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  CompanyBrainFields,
  CompanyBrainRecordId,
  CompanyBrainRecordSummary,
  EnvironmentId,
} from "@t3tools/contracts";

import { textField } from "./companyTeam.logic";

/**
 * The other T4 servers this company works on. The company's own machine is always one; these
 * records add more, so every teammate's client and agent sees the same list.
 */
export const MACHINES_COLLECTION = "machines";

export const MACHINES_COLLECTION_LABEL = "Machines";

export const MACHINES_DESCRIPTION =
  "The machines this company works on. One file per machine, with the T4 environment it is.";

export interface CompanyMachine {
  /** `null` for the company's own machine, which needs no record. */
  readonly recordId: CompanyBrainRecordId | null;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  /** The teammate whose own computer this is; `null` for a machine the company provides. */
  readonly ownerMemberId: string | null;
}

function machineFromRecord(record: CompanyBrainRecordSummary): CompanyMachine | null {
  const environmentId = textField(record.fields, "environmentId");
  const ownerMemberId = textField(record.fields, "ownerMemberId");
  return environmentId === ""
    ? null
    : {
        recordId: record.id,
        name: record.title,
        environmentId: environmentId as EnvironmentId,
        ownerMemberId: ownerMemberId === "" ? null : ownerMemberId,
      };
}

/** A teammate who adds a machine adds their own computer; an owner or admin adds a shared one. */
export const machineFields = (
  environmentId: EnvironmentId,
  ownerMemberId: string | null,
): CompanyBrainFields => ({
  kind: "machine",
  environmentId,
  ...(ownerMemberId === null ? {} : { ownerMemberId }),
});

export const machineOwners = (machines: ReadonlyArray<CompanyMachine>) =>
  new Map<string, string>(
    machines.flatMap((machine) =>
      machine.ownerMemberId === null ? [] : [[machine.environmentId, machine.ownerMemberId]],
    ),
  );

/** The company's machine first, then each listed one once. */
export function companyMachines(input: {
  readonly home: { readonly environmentId: EnvironmentId; readonly name: string };
  readonly records: ReadonlyArray<CompanyBrainRecordSummary>;
}): ReadonlyArray<CompanyMachine> {
  const seen = new Set<string>([input.home.environmentId]);
  const listed = input.records.flatMap((record) => {
    const machine = machineFromRecord(record);
    if (machine === null || seen.has(machine.environmentId)) return [];
    seen.add(machine.environmentId);
    return [machine];
  });
  return [{ recordId: null, ownerMemberId: null, ...input.home }, ...listed];
}

/** Which teammates hold access on a machine: signed in, or holding an unused invite. */
export function machineMemberAccess(snapshot: AuthAccessSnapshot) {
  const access = new Map<string, "online" | "signed-in" | "invited">();
  for (const link of snapshot.pairingLinks) {
    const memberId = companyMemberIdFromSubject(link.subject);
    if (memberId !== null && !access.has(memberId)) access.set(memberId, "invited");
  }
  for (const session of snapshot.clientSessions) {
    const memberId = companyMemberIdFromSubject(session.subject);
    if (memberId === null) continue;
    if (session.connected) access.set(memberId, "online");
    else if (access.get(memberId) !== "online") access.set(memberId, "signed-in");
  }
  return access;
}

/**
 * What removing a teammate must revoke on each company machine, and the machines where their
 * access could not be read (not connected here, or not an admin there).
 */
export function removalPlan(input: {
  readonly memberId: string;
  readonly machines: ReadonlyArray<CompanyMachine>;
  readonly snapshots: ReadonlyArray<AuthAccessSnapshot | null>;
}) {
  const subject = `member:${input.memberId}`;
  const revoke: Array<{
    readonly environmentId: EnvironmentId;
    readonly sessionIds: ReadonlyArray<AuthAccessSnapshot["clientSessions"][number]["sessionId"]>;
    readonly pairingLinkIds: ReadonlyArray<string>;
  }> = [];
  const unchecked: Array<string> = [];
  input.machines.forEach((machine, index) => {
    const snapshot = input.snapshots[index] ?? null;
    if (snapshot === null) {
      unchecked.push(machine.name);
      return;
    }
    const sessionIds = snapshot.clientSessions
      .filter((session) => session.subject === subject)
      .map((session) => session.sessionId);
    const pairingLinkIds = snapshot.pairingLinks
      .filter((link) => link.subject === subject)
      .map((link) => link.id);
    if (sessionIds.length > 0 || pairingLinkIds.length > 0) {
      revoke.push({ environmentId: machine.environmentId, sessionIds, pairingLinkIds });
    }
  });
  return { revoke, unchecked };
}

/** A machine's access list, from its live access feed, once it has loaded. */
export function accessSnapshotOf(event: AuthAccessStreamEvent | null): AuthAccessSnapshot | null {
  return event?.type === "snapshot" ? event.payload : null;
}
