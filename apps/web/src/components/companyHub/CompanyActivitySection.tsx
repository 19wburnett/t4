import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { CompanyBrainCollectionId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { companyBrainEnvironment } from "~/state/companyBrain";
import { useProjects, useQuietThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type ActivityActor,
  type ActivityView,
  type ActorSummary,
  employeeThreads,
  everyoneSummaries,
  memberFromRecord,
  MEMBERS_COLLECTION,
  personThreads,
  projectThreads,
  THREAD_ACTIVITY_LABELS,
  threadActivity,
  threadStarterName,
} from "./companyPeople.logic";
import { employeeFromRecord, TEAM_COLLECTION } from "./companyTeam.logic";

const OWNER_LABEL = "Owner";
const ROW_LIMIT = 20;
const OWNER_KEY = "owner";

const VIEW_LABELS: Record<ActivityView, string> = {
  everyone: "Everyone",
  person: "People",
  employee: "AI employees",
  project: "Projects",
};

function useBrainRecords(environmentId: EnvironmentId, projectId: ProjectId, collection: string) {
  const listing = useAtomValue(
    companyBrainEnvironment.records({
      environmentId,
      input: { projectId, collection: CompanyBrainCollectionId.make(collection) },
    }),
  );
  return AsyncResult.getOrElse(listing, () => null)?.records ?? [];
}

/**
 * What everyone on this machine is doing, one view at a time. It reads only thread shells, so
 * watching the team never loads a transcript; opening a row does.
 */
export function CompanyActivitySection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const memberRecords = useBrainRecords(props.environmentId, props.projectId, MEMBERS_COLLECTION);
  const employeeRecords = useBrainRecords(props.environmentId, props.projectId, TEAM_COLLECTION);
  const members = memberRecords.map(memberFromRecord);
  const employees = employeeRecords.map(employeeFromRecord);
  const shells = useQuietThreadShells().filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);

  const [view, setView] = useState<ActivityView>("everyone");
  const [personKey, setPersonKey] = useState<string>(OWNER_KEY);
  const [employeeKey, setEmployeeKey] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string>(props.projectId);

  const openActor = (actor: ActivityActor) => {
    if (actor.kind === "employee") {
      setEmployeeKey(actor.employee.recordId);
      setView("employee");
    } else {
      setPersonKey(actor.kind === "owner" ? OWNER_KEY : actor.member.recordId);
      setView("person");
    }
  };

  const selectedEmployee =
    employees.find((employee) => employee.recordId === employeeKey) ?? employees[0] ?? null;

  return (
    <section aria-labelledby="company-hub-activity" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-activity" className="text-sm font-medium text-muted-foreground">
          Activity
        </h2>
        <ToggleGroup
          aria-label="Activity view"
          className="ml-auto"
          value={[view]}
          onValueChange={(next) => {
            const value = next[0];
            if (
              value === "everyone" ||
              value === "person" ||
              value === "employee" ||
              value === "project"
            ) {
              setView(value);
            }
          }}
        >
          {(Object.keys(VIEW_LABELS) as ActivityView[]).map((key) => (
            <Toggle key={key} value={key}>
              {VIEW_LABELS[key]}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {view === "everyone" ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {everyoneSummaries({ threads: shells, members, employees }).map((summary) => (
            <ActorCard key={summary.key} summary={summary} onOpen={openActor} />
          ))}
        </div>
      ) : view === "person" ? (
        <>
          <Picker
            label="Person"
            value={personKey}
            items={[
              { value: OWNER_KEY, label: OWNER_LABEL },
              ...members.map((member) => ({ value: member.recordId, label: member.name })),
            ]}
            onChange={setPersonKey}
          />
          <ThreadList
            threads={personThreads(shells, personKey === OWNER_KEY ? null : personKey, members)}
            empty="Nothing started yet."
          />
        </>
      ) : view === "employee" ? (
        selectedEmployee === null ? (
          <p className="text-sm text-muted-foreground">No AI employees yet. Hire one in Team.</p>
        ) : (
          <>
            <Picker
              label="AI employee"
              value={selectedEmployee.recordId}
              items={employees.map((employee) => ({
                value: employee.recordId,
                label: employee.name,
              }))}
              onChange={setEmployeeKey}
            />
            <ThreadList
              threads={employeeThreads(shells, selectedEmployee.recordId)}
              starter={(thread) => threadStarterName(thread, members, OWNER_LABEL)}
              empty={`Nobody has asked ${selectedEmployee.name} for work yet.`}
            />
          </>
        )
      ) : (
        <>
          <Picker
            label="Project"
            value={projectKey}
            items={projects.map((project) => ({ value: project.id, label: project.title }))}
            onChange={setProjectKey}
          />
          <ThreadList
            threads={projectThreads(shells, projectKey as ProjectId)}
            starter={(thread) => threadStarterName(thread, members, OWNER_LABEL)}
            empty="No work in this project yet."
          />
        </>
      )}
    </section>
  );
}

function ActorCard(props: {
  readonly summary: ActorSummary;
  readonly onOpen: (actor: ActivityActor) => void;
}) {
  const { actor, latest, active, threads } = props.summary;
  const name =
    actor.kind === "owner"
      ? OWNER_LABEL
      : actor.kind === "member"
        ? actor.member.name
        : actor.employee.name;
  const kindLabel =
    actor.kind === "employee" ? actor.employee.role : actor.kind === "owner" ? "You" : "Teammate";
  return (
    <button
      type="button"
      onClick={() => props.onOpen(actor)}
      className="flex min-w-0 cursor-pointer flex-col items-start gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{kindLabel}</span>
      </span>
      <span className={cn("text-xs", active > 0 ? "text-foreground" : "text-muted-foreground")}>
        {active > 0
          ? `${active} active`
          : threads.length > 0
            ? `${threads.length} thread${threads.length === 1 ? "" : "s"}, none running`
            : "No work yet"}
      </span>
      {latest !== null ? (
        <span className="w-full truncate text-xs text-muted-foreground">
          {THREAD_ACTIVITY_LABELS[threadActivity(latest)]} · {latest.title}
        </span>
      ) : null}
    </button>
  );
}

function Picker(props: {
  readonly label: string;
  readonly value: string;
  readonly items: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value}
      items={Object.fromEntries(props.items.map((item) => [item.value, item.label]))}
      onValueChange={(value) => {
        if (typeof value === "string") props.onChange(value);
      }}
    >
      <SelectTrigger aria-label={props.label} className="w-56 max-w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {props.items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ThreadList(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly starter?: (thread: EnvironmentThreadShell) => string;
  readonly empty: string;
}) {
  const navigate = useNavigate();
  if (props.threads.length === 0) {
    return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  }
  const shown = props.threads.slice(0, ROW_LIMIT);
  return (
    <ul className="flex flex-col">
      {shown.map((thread) => {
        const activity = threadActivity(thread);
        return (
          <li key={`${thread.environmentId}:${thread.id}`}>
            <button
              type="button"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
                })
              }
              className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span
                className={cn(
                  "w-36 shrink-0 truncate text-xs",
                  activity === "idle" ? "text-muted-foreground" : "text-foreground",
                  activity === "failed" && "text-destructive",
                )}
              >
                {THREAD_ACTIVITY_LABELS[activity]}
              </span>
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {props.starter ? (
                <span className="shrink-0 truncate text-xs text-muted-foreground">
                  {props.starter(thread)}
                </span>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatRelativeTimeLabel(thread.updatedAt)}
              </span>
            </button>
          </li>
        );
      })}
      {props.threads.length > ROW_LIMIT ? (
        <li className="px-1.5 pt-1 text-xs text-muted-foreground">
          And {props.threads.length - ROW_LIMIT} more
        </li>
      ) : null}
    </ul>
  );
}
