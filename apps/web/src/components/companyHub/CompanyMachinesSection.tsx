import { memberAccess } from "@t3tools/client-runtime/state/companyMembers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  CompanyBrainCollectionId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { authEnvironment } from "~/state/auth";
import { companyBrainEnvironment } from "~/state/companyBrain";
import { companyMembers } from "~/state/companyMembers";
import { useConnectedEnvironmentIds, useEnvironments } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { brainFailure } from "./companyBrain.logic";
import {
  type CompanyMachine,
  machineFields,
  machineMemberAccess,
  MACHINES_COLLECTION,
  MACHINES_COLLECTION_LABEL,
  MACHINES_DESCRIPTION,
} from "./companyMachines.logic";
import { type Member, memberFromRecord, MEMBERS_COLLECTION } from "./companyPeople.logic";
import { InviteLinkDialog } from "./CompanyPeopleSection";
import { useCompanyMachines, useCompanyRecords } from "./useCompanyRecords";

const ACCESS_LABELS = {
  online: "online",
  "signed-in": "signed in",
  invited: "invite not used yet",
} as const;

const errorToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

/**
 * The machines the company works on and who may use each. Giving a teammate a machine mints
 * their invite on that machine, so the admin's own session there is what grants it.
 */
export function CompanyMachinesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const machines = useCompanyMachines(props.environmentId, props.projectId);
  const members = useCompanyRecords(props.environmentId, props.projectId, MEMBERS_COLLECTION).map(
    memberFromRecord,
  );
  const listing = useAtomValue(
    companyBrainEnvironment.collections({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const hasCollection =
    AsyncResult.getOrElse(listing, () => null)?.collections.some(
      (collection) => collection.id === MACHINES_COLLECTION,
    ) ?? false;
  const canWrite = useAtomValue(
    companyBrainEnvironment.saveRecord.permissionAtom(props.environmentId),
  );
  const saveCollection = useAtomCommand(companyBrainEnvironment.saveCollection, {
    label: "add machines collection",
  });
  const saveRecord = useAtomCommand(companyBrainEnvironment.saveRecord, {
    label: "add machine",
  });
  const deleteRecord = useAtomCommand(companyBrainEnvironment.deleteRecord, {
    label: "remove machine",
  });
  const { environments } = useEnvironments();
  const listed = new Set<string>(machines.map((machine) => machine.environmentId));
  const candidates = environments.filter((environment) => !listed.has(environment.environmentId));

  const addMachine = async (environmentId: EnvironmentId, name: string) => {
    if (!hasCollection) {
      const created = await saveCollection({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          collection: CompanyBrainCollectionId.make(MACHINES_COLLECTION),
          label: MACHINES_COLLECTION_LABEL,
          description: MACHINES_DESCRIPTION,
        },
      });
      if (created._tag === "Failure") {
        errorToast("Could not add the machine list", brainFailure(created.cause).message);
        return;
      }
    }
    const saved = await saveRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(MACHINES_COLLECTION),
        title: name,
        set: machineFields(environmentId),
      },
    });
    if (saved._tag === "Failure") {
      errorToast("Could not add machine", brainFailure(saved.cause).message);
    }
  };

  const removeMachine = async (machine: CompanyMachine) => {
    if (machine.recordId === null) return;
    const deleted = await deleteRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(MACHINES_COLLECTION),
        recordId: machine.recordId,
      },
    });
    if (deleted._tag === "Failure") {
      errorToast("Could not remove machine", brainFailure(deleted.cause).message);
    }
  };

  return (
    <section aria-labelledby="company-hub-machines" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-machines" className="text-sm font-medium text-muted-foreground">
          Machines
        </h2>
        {canWrite ? (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost" className="ml-auto" />}>
              <PlusIcon aria-hidden />
              Add machine
            </MenuTrigger>
            <MenuPopup align="end">
              {candidates.length === 0 ? (
                <MenuItem disabled>
                  Connect another T4 machine in Settings → Environments first
                </MenuItem>
              ) : (
                candidates.map((environment) => (
                  <MenuItem
                    key={environment.environmentId}
                    onClick={() => void addMachine(environment.environmentId, environment.label)}
                  >
                    {environment.label}
                  </MenuItem>
                ))
              )}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {machines.map((machine) => (
          <MachineCard
            key={machine.environmentId}
            machine={machine}
            members={members}
            {...(canWrite && machine.recordId !== null
              ? { onRemove: () => void removeMachine(machine) }
              : {})}
          />
        ))}
      </div>
    </section>
  );
}

function MachineCard(props: {
  readonly machine: CompanyMachine;
  readonly members: ReadonlyArray<Member>;
  readonly onRemove?: () => void;
}) {
  const connected = useConnectedEnvironmentIds().includes(props.machine.environmentId);
  const canManage = useEnvironmentScope(props.machine.environmentId, AuthAccessWriteScope);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.machine.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {props.machine.recordId === null
            ? "Company machine"
            : connected
              ? "Connected"
              : "Not connected here"}
        </span>
        {props.onRemove ? (
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Machine actions" />}
            >
              <EllipsisIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem variant="destructive" onClick={props.onRemove}>
                Remove from company
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {connected && canManage ? (
        <MachineAccess environmentId={props.machine.environmentId} members={props.members} />
      ) : (
        <span className="text-xs text-muted-foreground">
          {connected
            ? "Only an admin of this machine can see and change who uses it."
            : "Connect to it to see and change who uses it."}
        </span>
      )}
    </div>
  );
}

/** Who may use one machine, read from that machine's own access list. */
function MachineAccess(props: {
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<Member>;
}) {
  const access = useAtomValue(
    authEnvironment.accessChanges({ environmentId: props.environmentId, input: null }),
  );
  const event = AsyncResult.getOrElse(access, () => null);
  const snapshot = event?.type === "snapshot" ? event.payload : null;
  const revoke = useAtomCommand(companyMembers.revoke, { label: "remove machine access" });
  const [inviting, setInviting] = useState<Member | null>(null);
  if (snapshot === null) return null;

  const holders = machineMemberAccess(snapshot);
  const withAccess = props.members.filter((member) => holders.has(member.recordId));
  const without = props.members.filter((member) => !holders.has(member.recordId));

  const removeAccess = async (member: Member) => {
    const held = memberAccess(snapshot, member.recordId);
    const revoked = await revoke({
      environmentId: props.environmentId,
      input: {
        sessionIds: held.sessions.map((session) => session.sessionId),
        pairingLinkIds: held.pairingLinks.map((link) => link.id),
      },
    });
    if (revoked._tag === "Failure") {
      const error = squashAtomCommandFailure(revoked);
      errorToast(
        "Could not remove access",
        error instanceof Error ? error.message : "Could not reach this machine.",
      );
    }
  };

  return (
    <>
      <span className="text-xs text-muted-foreground">
        {withAccess.length === 0
          ? "No teammates use it yet."
          : withAccess
              .map((member) => {
                const status = holders.get(member.recordId);
                return status === undefined
                  ? member.name
                  : `${member.name} (${ACCESS_LABELS[status]})`;
              })
              .join(", ")}
      </span>
      {props.members.length > 0 ? (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" className="mt-1 self-start" />}>
            Manage access
          </MenuTrigger>
          <MenuPopup align="start">
            {without.map((member) => (
              <MenuItem key={member.recordId} onClick={() => setInviting(member)}>
                Give {member.name} access
              </MenuItem>
            ))}
            {without.length > 0 && withAccess.length > 0 ? <MenuSeparator /> : null}
            {withAccess.map((member) => (
              <MenuItem
                key={member.recordId}
                variant="destructive"
                onClick={() => void removeAccess(member)}
              >
                Take away {member.name}'s access
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
      {inviting !== null ? (
        <InviteLinkDialog
          environmentId={props.environmentId}
          member={inviting}
          onClose={() => setInviting(null)}
        />
      ) : null}
    </>
  );
}
