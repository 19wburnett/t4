import {
  type CompanyBrainCollection,
  CompanyBrainCollectionId,
  type CompanyBrainRecordSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArrowRightIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { companyBrainEnvironment } from "~/state/companyBrain";
import { useAtomCommand } from "~/state/use-atom-command";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { brainFailure } from "./companyBrain.logic";
import {
  buildEmployeePrompt,
  EMPLOYEE_PROVIDER_LABELS,
  EMPLOYEE_TEMPLATES,
  type Employee,
  type EmployeeTemplate,
  employeeBody,
  employeeCollections,
  employeeFields,
  employeeFromRecord,
  employeeTargetOf,
  TEAM_COLLECTION,
  TEAM_COLLECTION_LABEL,
} from "./companyTeam.logic";
import { useStartWorkThread } from "./useStartWorkThread";

const TEAM_DESCRIPTION =
  "The AI employees that work on this company. One file per employee, with the role, where it runs, and its instructions.";

/** Hiring writes a brain record, so the roster works without a new store or a new schema. */
export function CompanyTeamSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const listing = useAtomValue(
    companyBrainEnvironment.collections({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const canWrite = useAtomValue(
    companyBrainEnvironment.saveRecord.permissionAtom(props.environmentId),
  );
  const saveCollection = useAtomCommand(companyBrainEnvironment.saveCollection, {
    label: "add team collection",
  });
  const saveRecord = useAtomCommand(companyBrainEnvironment.saveRecord, {
    label: "hire employee",
  });
  const [hiring, setHiring] = useState(false);

  const collections = AsyncResult.getOrElse(listing, () => null)?.collections ?? [];
  const team = collections.find((collection) => collection.id === TEAM_COLLECTION) ?? null;

  const hire = async (template: EmployeeTemplate) => {
    if (hiring || !canWrite) return;
    setHiring(true);
    if (team === null) {
      const created = await saveCollection({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          collection: CompanyBrainCollectionId.make(TEAM_COLLECTION),
          label: TEAM_COLLECTION_LABEL,
          description: TEAM_DESCRIPTION,
        },
      });
      if (created._tag === "Failure") {
        setHiring(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start the team",
            description: brainFailure(created.cause).message,
          }),
        );
        return;
      }
    }
    const saved = await saveRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(TEAM_COLLECTION),
        title: template.role,
        set: employeeFields(template),
        body: employeeBody(template),
      },
    });
    setHiring(false);
    if (saved._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not hire",
          description: brainFailure(saved.cause).message,
        }),
      );
    }
  };

  return (
    <section aria-labelledby="company-hub-team" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-team" className="text-sm font-medium text-muted-foreground">
          Team
        </h2>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                disabled={!canWrite || hiring}
              />
            }
          >
            <PlusIcon aria-hidden />
            Hire
          </MenuTrigger>
          <MenuPopup align="end">
            {EMPLOYEE_TEMPLATES.map((template) => (
              <MenuItem key={template.id} onClick={() => void hire(template)}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span>{template.role}</span>
                  <span className="text-xs text-muted-foreground">
                    {EMPLOYEE_PROVIDER_LABELS[template.provider]}
                  </span>
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
      {listing._tag === "Failure" ? (
        <p role="alert" className="text-sm text-destructive">
          {brainFailure(listing.cause).message}
        </p>
      ) : listing._tag === "Initial" ? null : team === null ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle>No team yet</EmptyTitle>
            <EmptyDescription>
              Hire an AI employee for a job you keep doing. Each one is a record in{" "}
              <span className="whitespace-nowrap">company/{TEAM_COLLECTION}/</span> with its role
              and instructions, so it can work from the same brain as everyone else.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <TeamRoster
          environmentId={props.environmentId}
          projectId={props.projectId}
          collection={team}
        />
      )}
    </section>
  );
}

function TeamRoster(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly collection: CompanyBrainCollection;
}) {
  const listing = useAtomValue(
    companyBrainEnvironment.records({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, collection: props.collection.id },
    }),
  );
  const [asking, setAsking] = useState<Employee | null>(null);
  const records = AsyncResult.getOrElse(listing, () => null)?.records ?? [];

  return (
    <>
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Hire someone with <span className="font-medium">Hire</span>. Their instructions live in
          their record, so you can change how they work in Company brain.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {records.map((record) => (
            <EmployeeCard
              key={record.id}
              record={record}
              onAsk={() => setAsking(employeeFromRecord(record))}
            />
          ))}
        </div>
      )}
      {asking !== null ? (
        <AskEmployeeDialog
          environmentId={props.environmentId}
          projectId={props.projectId}
          employee={asking}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </>
  );
}

function EmployeeCard(props: {
  readonly record: CompanyBrainRecordSummary;
  readonly onAsk: () => void;
}) {
  const employee = employeeFromRecord(props.record);
  const collections = employeeCollections(props.record);
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{employee.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{employee.providerLabel}</span>
      </div>
      <span className="text-xs text-muted-foreground">{employee.role}</span>
      {collections.length > 0 ? (
        <span className="truncate text-xs text-muted-foreground">
          Works with {collections.join(", ")}
        </span>
      ) : null}
      <Button size="xs" variant="outline" className="mt-1 self-start" onClick={props.onAsk}>
        Ask for work
        <ArrowRightIcon aria-hidden />
      </Button>
    </div>
  );
}

function AskEmployeeDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly employee: Employee;
  readonly onClose: () => void;
}) {
  const record = useAtomValue(
    companyBrainEnvironment.record({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(TEAM_COLLECTION),
        recordId: props.employee.recordId,
      },
    }),
  );
  const instructions = AsyncResult.getOrElse(record, () => null)?.body ?? "";
  const startWorkThread = useStartWorkThread();
  const [task, setTask] = useState("");

  const submit = () => {
    if (task.trim() === "") return;
    void startWorkThread(
      { environmentId: props.environmentId, id: props.projectId },
      buildEmployeePrompt(props.employee, instructions, task),
      employeeTargetOf(props.employee.provider),
    );
    props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Ask {props.employee.name} for work</DialogTitle>
          <DialogDescription>
            Starts a thread as {props.employee.name}, with their instructions and the company brain.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Textarea
            autoFocus
            aria-label="What should they do?"
            placeholder={`What should ${props.employee.name} do?`}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={4}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" disabled={task.trim() === ""} onClick={submit}>
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
