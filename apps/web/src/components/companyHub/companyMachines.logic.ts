import { companyMemberIdFromSubject } from "@t3tools/contracts";
import type {
  AuthAccessSnapshot,
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
}

function machineFromRecord(record: CompanyBrainRecordSummary): CompanyMachine | null {
  const environmentId = textField(record.fields, "environmentId");
  return environmentId === ""
    ? null
    : { recordId: record.id, name: record.title, environmentId: environmentId as EnvironmentId };
}

export const machineFields = (environmentId: EnvironmentId): CompanyBrainFields => ({
  kind: "machine",
  environmentId,
});

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
  return [{ recordId: null, ...input.home }, ...listed];
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
