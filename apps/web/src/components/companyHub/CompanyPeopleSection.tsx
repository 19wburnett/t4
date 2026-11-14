import {
  CompanyMemberAccessError,
  memberAccess,
} from "@t3tools/client-runtime/state/companyMembers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  COMPANY_ADMIN_SCOPES,
  type CompanyBrainCollection,
  CompanyBrainCollectionId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CopyIcon, EllipsisIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { authAccessListAtom } from "~/state/auth";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { companyBrainEnvironment } from "~/state/companyBrain";
import { companyMembers } from "~/state/companyMembers";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { brainFailure } from "./companyBrain.logic";
import { accessSnapshotOf, removalPlan } from "./companyMachines.logic";
import {
  type Member,
  memberFields,
  memberFromRecord,
  memberInviteUrl,
  type MemberRole,
  MEMBERS_COLLECTION,
  MEMBERS_COLLECTION_LABEL,
  MEMBERS_DESCRIPTION,
} from "./companyPeople.logic";
import { useCompanyMachines } from "./useCompanyRecords";

/** Our own failures explain themselves; anything else is a transport problem. */
const failureMessage = (error: unknown) =>
  error instanceof CompanyMemberAccessError
    ? error.message
    : "Could not reach this machine. Check that it is online and try again.";

const errorToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

/**
 * Teammates on this machine. Inviting writes their brain record and mints a pairing link that
 * signs them in as themselves; removing revokes their sessions and unused links here.
 */
export function CompanyPeopleSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const listing = useAtomValue(
    companyBrainEnvironment.collections({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const canManage = useEnvironmentScope(props.environmentId, AuthAccessWriteScope);
  const [inviting, setInviting] = useState(false);
  const collections = AsyncResult.getOrElse(listing, () => null)?.collections ?? [];
  const people = collections.find((collection) => collection.id === MEMBERS_COLLECTION) ?? null;

  return (
    <section aria-labelledby="company-hub-people" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-people" className="text-sm font-medium text-muted-foreground">
          People
        </h2>
        {canManage ? (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setInviting(true)}>
            <UserPlusIcon aria-hidden />
            Invite
          </Button>
        ) : null}
      </div>
      {listing._tag === "Failure" ? (
        <p role="alert" className="text-sm text-destructive">
          {brainFailure(listing.cause).message}
        </p>
      ) : listing._tag === "Initial" ? null : people === null ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>Just you so far</EmptyTitle>
            <EmptyDescription>
              Invite a teammate to work on this machine. They get a link that signs them in as
              themselves, so everyone can see who started what.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <PeopleRoster
          environmentId={props.environmentId}
          projectId={props.projectId}
          collection={people}
          canManage={canManage}
        />
      )}
      {inviting ? (
        <InviteDialog
          environmentId={props.environmentId}
          projectId={props.projectId}
          hasCollection={people !== null}
          onClose={() => setInviting(false)}
        />
      ) : null}
    </section>
  );
}

function PeopleRoster(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly collection: CompanyBrainCollection;
  readonly canManage: boolean;
}) {
  const listing = useAtomValue(
    companyBrainEnvironment.records({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, collection: props.collection.id },
    }),
  );
  const members = (AsyncResult.getOrElse(listing, () => null)?.records ?? []).map(memberFromRecord);
  if (members.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Invite someone with <span className="font-medium">Invite</span>.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {members.map((member) =>
        props.canManage ? (
          <ManagedMemberCard
            key={member.recordId}
            environmentId={props.environmentId}
            projectId={props.projectId}
            member={member}
          />
        ) : (
          <MemberCard key={member.recordId} member={member} />
        ),
      )}
    </div>
  );
}

function MemberCard(props: {
  readonly member: Member;
  readonly status?: string;
  readonly actions?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.member.name}</span>
        {props.member.role === "admin" ? <Badge variant="secondary">Admin</Badge> : null}
        {props.actions}
      </div>
      {props.member.email !== "" ? (
        <span className="truncate text-xs text-muted-foreground">{props.member.email}</span>
      ) : null}
      {props.status ? <span className="text-xs text-muted-foreground">{props.status}</span> : null}
    </div>
  );
}

function ManagedMemberCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly member: Member;
}) {
  const machines = useCompanyMachines(props.environmentId, props.projectId);
  const accessLists = useAtomValue(
    authAccessListAtom(environmentIdsKey(machines.map((machine) => machine.environmentId))),
  );
  const snapshots = accessLists.map((result) =>
    accessSnapshotOf(AsyncResult.getOrElse(result, () => null)),
  );
  // The company's own machine is always first.
  const snapshot = snapshots[0] ?? null;
  const held = snapshot === null ? null : memberAccess(snapshot, props.member.recordId);
  const plan = removalPlan({ memberId: props.member.recordId, machines, snapshots });
  const revoke = useAtomCommand(companyMembers.revoke, { label: "remove teammate" });
  const deleteRecord = useAtomCommand(companyBrainEnvironment.deleteRecord, {
    label: "remove teammate record",
  });
  const [linkFor, setLinkFor] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);

  const status =
    held === null
      ? undefined
      : held.sessions.some((session) => session.connected)
        ? "Online"
        : held.sessions.length > 0
          ? "Signed in"
          : held.pairingLinks.length > 0
            ? "Invite not used yet"
            : "No access on this machine";

  // Access on every company machine goes first, so the record never outlives it unnoticed.
  const remove = async () => {
    for (const machine of plan.revoke) {
      const revoked = await revoke({
        environmentId: machine.environmentId,
        input: { sessionIds: machine.sessionIds, pairingLinkIds: machine.pairingLinkIds },
      });
      if (revoked._tag === "Failure") {
        errorToast("Could not remove access", failureMessage(squashAtomCommandFailure(revoked)));
        return;
      }
    }
    const deleted = await deleteRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(MEMBERS_COLLECTION),
        recordId: props.member.recordId,
      },
    });
    setRemoving(false);
    if (deleted._tag === "Failure") {
      errorToast("Access removed, but the record stayed", brainFailure(deleted.cause).message);
    }
  };

  return (
    <>
      <MemberCard
        member={props.member}
        {...(status === undefined ? {} : { status })}
        actions={
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Teammate actions" />}
            >
              <EllipsisIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setLinkFor(props.member)}>New invite link</MenuItem>
              <MenuItem variant="destructive" onClick={() => setRemoving(true)}>
                Remove from company
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      />
      {linkFor !== null ? (
        <InviteLinkDialog
          environmentId={props.environmentId}
          member={linkFor}
          onClose={() => setLinkFor(null)}
        />
      ) : null}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {props.member.name}?</DialogTitle>
            <DialogDescription>
              Signs them out of the company's machines, cancels unused invite links and deletes
              their record. Threads they started stay, so you can still read and continue them.
            </DialogDescription>
          </DialogHeader>
          {plan.unchecked.length > 0 ? (
            <DialogPanel>
              <p className="text-sm text-muted-foreground">
                Couldn't check {plan.unchecked.join(", ")}. Any access they have there stays until
                an admin of that machine takes it away under Machines.
              </p>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={snapshot === null}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function InviteDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly hasCollection: boolean;
  readonly onClose: () => void;
}) {
  const saveCollection = useAtomCommand(companyBrainEnvironment.saveCollection, {
    label: "add people collection",
  });
  const saveRecord = useAtomCommand(companyBrainEnvironment.saveRecord, {
    label: "add teammate",
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [saving, setSaving] = useState(false);
  const [invited, setInvited] = useState<Member | null>(null);

  if (invited !== null) {
    return (
      <InviteLinkDialog
        environmentId={props.environmentId}
        member={invited}
        onClose={props.onClose}
      />
    );
  }

  const submit = async () => {
    if (name.trim() === "" || saving) return;
    setSaving(true);
    if (!props.hasCollection) {
      const created = await saveCollection({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          collection: CompanyBrainCollectionId.make(MEMBERS_COLLECTION),
          label: MEMBERS_COLLECTION_LABEL,
          description: MEMBERS_DESCRIPTION,
        },
      });
      if (created._tag === "Failure") {
        setSaving(false);
        errorToast("Could not add the people list", brainFailure(created.cause).message);
        return;
      }
    }
    const saved = await saveRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(MEMBERS_COLLECTION),
        title: name.trim(),
        set: memberFields({ email, role }),
      },
    });
    setSaving(false);
    if (saved._tag === "Failure") {
      errorToast("Could not add teammate", brainFailure(saved.cause).message);
      return;
    }
    setInvited(memberFromRecord(saved.value));
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>
            They join this company and work on this machine as themselves.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Role</Label>
              <ToggleGroup
                aria-label="Role"
                className="w-full *:flex-1"
                value={[role]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "admin" || value === "member") setRole(value);
                }}
              >
                <Toggle value="member">Member</Toggle>
                <Toggle value="admin">Admin</Toggle>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {role === "admin"
                  ? "Admins can invite people and change anyone's threads."
                  : "Members can see everyone's work and change the threads they start."}
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={name.trim() === "" || saving} onClick={() => void submit()}>
            Create invite link
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Mints a fresh one-use link each time it opens: links are single-use by design. */
export function InviteLinkDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly member: Member;
  readonly onClose: () => void;
}) {
  const invite = useAtomCommand(companyMembers.invite, { label: "invite teammate" });
  const [link, setLink] = useState<{ readonly url: string } | { readonly error: string } | null>(
    null,
  );
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const mint = async () => {
    const minted = await invite({
      environmentId: props.environmentId,
      input: {
        memberId: props.member.recordId,
        label: props.member.name,
        ...(props.member.role === "admin" ? { scopes: COMPANY_ADMIN_SCOPES } : {}),
      },
    });
    setLink(
      minted._tag === "Success"
        ? { url: memberInviteUrl(minted.value.host, minted.value.credential) }
        : { error: failureMessage(squashAtomCommandFailure(minted)) },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite link for {props.member.name}</DialogTitle>
          <DialogDescription>
            Send this to {props.member.name}. It works once, and their browser needs to reach this
            machine, for example over Tailscale.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {link === null ? (
            <Button size="sm" className="self-start" onClick={() => void mint()}>
              Create link
            </Button>
          ) : "error" in link ? (
            <p role="alert" className="text-sm text-destructive">
              {link.error}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Input readOnly value={link.url} aria-label="Invite link" className="min-w-0" />
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Copy invite link"
                onClick={() => copyToClipboard(link.url)}
              >
                {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              </Button>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
