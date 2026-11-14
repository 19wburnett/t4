import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { AuthFilesystemReadScope, CompanyBrainCollectionId } from "@t3tools/contracts";
import { TEAM_COLLECTION } from "@t3tools/shared/companyTeam";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { BotIcon, PlusIcon } from "lucide-react";
import { memo, useState } from "react";

import { useQuietThreadShells } from "~/state/entities";
import { companyBrainEnvironment } from "~/state/companyBrain";
import { useEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "~/threadRoutes";
import { readLastCompany } from "../companyHub/lastCompany";
import { companyProjectOf } from "../companyHub/CompanySetup";
import { AskEmployeeDialog } from "../companyHub/CompanyTeamSection";
import { type Employee, employeeFromRecord } from "../companyHub/companyTeam.logic";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "../ui/sidebar";

const BOT_THREAD_LIMIT = 5;

type CompanyProject = ReturnType<typeof companyProjectOf>;

/** The last company's AI employees, each with its own threads, like a team chat. */
export const SidebarBots = memo(function SidebarBots() {
  const projectGroups = useSettingsProjectGroups();
  const last = readLastCompany();
  const group = projectGroups.find((candidate) => candidate.projectKey === last);
  if (group === undefined) return null;
  return <SidebarCompanyBots project={companyProjectOf(group)} />;
});

function SidebarCompanyBots(props: { readonly project: CompanyProject }) {
  const canRead = useEnvironmentScope(props.project.environmentId, AuthFilesystemReadScope);
  return canRead ? <SidebarBotList project={props.project} /> : null;
}

function SidebarBotList(props: { readonly project: CompanyProject }) {
  const { environmentId, id: projectId } = props.project;
  const listing = useAtomValue(
    companyBrainEnvironment.records({
      environmentId,
      input: { projectId, collection: CompanyBrainCollectionId.make(TEAM_COLLECTION) },
    }),
  );
  const shells = useQuietThreadShells();
  const [expanded, setExpanded] = useState(true);
  const [asking, setAsking] = useState<Employee | null>(null);
  // A company without a team yet shows nothing; hiring happens in Settings → Company.
  const records = AsyncResult.getOrElse(listing, () => null)?.records ?? [];
  if (records.length === 0) return null;

  const threadsByBot = new Map<string, Array<EnvironmentThreadShell>>();
  for (const thread of shells) {
    if (
      thread.bot == null ||
      thread.archivedAt !== null ||
      thread.environmentId !== environmentId ||
      thread.projectId !== projectId
    ) {
      continue;
    }
    const list = threadsByBot.get(thread.bot);
    if (list) list.push(thread);
    else threadsByBot.set(thread.bot, [thread]);
  }

  return (
    <SidebarGroup>
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Bots
      </CollapsibleSectionHeader>
      {expanded ? (
        <SidebarMenu>
          {records.map((record) => (
            <BotRow
              key={record.id}
              employee={employeeFromRecord(record)}
              environmentId={environmentId}
              threads={threadsByBot.get(record.id) ?? []}
              onNewThread={setAsking}
            />
          ))}
        </SidebarMenu>
      ) : null}
      {asking !== null ? (
        <AskEmployeeDialog
          environmentId={environmentId}
          projectId={projectId}
          employee={asking}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </SidebarGroup>
  );
}

function BotRow(props: {
  readonly employee: Employee;
  readonly environmentId: CompanyProject["environmentId"];
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onNewThread: (employee: Employee) => void;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = resolveThreadRouteTarget(useParams({ strict: false }));
  const activeThreadId = routeTarget?.kind === "server" ? routeTarget.threadRef.threadId : null;
  const [open, setOpen] = useState(() =>
    props.threads.some((thread) => thread.id === activeThreadId),
  );
  const [showAll, setShowAll] = useState(false);
  const threads = props.threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const shown = showAll ? threads : threads.slice(0, BOT_THREAD_LIMIT);

  return (
    <SidebarMenuItem>
      <div className="flex items-center">
        <SidebarMenuButton
          aria-expanded={open}
          title={`${props.employee.role} · ${props.employee.providerLabel}`}
          onClick={() => setOpen(!open)}
        >
          <BotIcon />
          <span>{props.employee.name}</span>
        </SidebarMenuButton>
        <SidebarMenuButton
          size="icon"
          aria-label={`New thread with ${props.employee.name}`}
          title={`New thread with ${props.employee.name}`}
          onClick={() => props.onNewThread(props.employee)}
        >
          <PlusIcon />
        </SidebarMenuButton>
      </div>
      {open ? (
        <SidebarMenuSub>
          {threads.length === 0 ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                size="sm"
                render={<button type="button" />}
                onClick={() => props.onNewThread(props.employee)}
              >
                <span className="text-sidebar-muted-foreground">Start a thread</span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : (
            shown.map((thread) => (
              <SidebarMenuSubItem key={thread.id}>
                <SidebarMenuSubButton
                  size="sm"
                  isActive={thread.id === activeThreadId}
                  render={<button type="button" />}
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(props.environmentId, thread.id),
                      ),
                    });
                  }}
                >
                  <span>{thread.title}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))
          )}
          {threads.length > BOT_THREAD_LIMIT ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                size="sm"
                render={<button type="button" />}
                onClick={() => setShowAll(!showAll)}
              >
                <span className="text-sidebar-muted-foreground">
                  {showAll ? "Show fewer" : `Show all ${threads.length}`}
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  );
}
