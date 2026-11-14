import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthFilesystemReadScope,
  type CompanyDraft,
  type ProjectId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useProviderEntryByEnvironmentAndInstanceId } from "~/hooks/useProviderEntryByEnvironmentAndInstanceId";
import { cn } from "~/lib/utils";
import { isProviderInstancePickerReady } from "~/providerInstances";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useThreadShells } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { useEnvironmentScope } from "~/state/session";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import ChatMarkdown from "../ChatMarkdown";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ThreadRowLeadingStatus } from "../ThreadStatusIndicators";
import { Button } from "../ui/button";
import { channelFailure } from "./companyChannels.logic";
import { CompanyBrainRecordsSection } from "./CompanyBrainRecordsSection";
import {
  CompanyAccountsSetup,
  CompanyBrainSetup,
  companyProjectOf,
  useCompanyBrainFile,
} from "./CompanySetup";
import { rememberLastCompany } from "./lastCompany";
import {
  AGENT_BRIDGE_DRIVER,
  type BridgeAgent,
  buildWorkTaskPrompt,
  COMPANY_DIR,
  connectedBridgeAgents,
  groupThreadsByAgent,
  type WorkTaskTarget,
  WORK_TASK_PRESETS,
} from "./companyHub.logic";
import { CompanyInboxSection } from "./CompanyInboxSection";
import { CompanyOutboxSection } from "./CompanyOutboxSection";
import { CompanyRoutinesSection } from "./CompanyRoutinesSection";
import { CompanyTeamSection } from "./CompanyTeamSection";
import { useStartWorkThread } from "./useStartWorkThread";

const LANE_THREAD_LIMIT = 8;

/** Everything for one company: its work, its brain, and the accounts it sends from. */
export function CompanyHub({ group }: { group: SidebarProjectSnapshot }) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records the visit in localStorage for the sidebar's Company button
  useEffect(() => rememberLastCompany(group.projectKey), [group.projectKey]);
  const primary = companyProjectOf(group);
  const brain = useCompanyBrainFile(primary);
  const hasCompanyBrain = brain.contents !== null;

  const canReadChannels = useEnvironmentScope(primary.environmentId, AuthFilesystemReadScope);
  const startWorkThread = useStartWorkThread();
  const startThread = (prompt: string, target: WorkTaskTarget) =>
    startWorkThread(primary, prompt, target);

  return (
    <>
      <section aria-labelledby="company-hub-start" className="flex flex-col gap-3">
        <h2 id="company-hub-start" className="text-sm font-medium text-muted-foreground">
          Start work
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {WORK_TASK_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() =>
                void startThread(buildWorkTaskPrompt(preset, hasCompanyBrain), preset.target)
              }
              className="flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="text-sm font-medium">{preset.label}</span>
              <span className="text-xs text-muted-foreground">{preset.description}</span>
            </button>
          ))}
        </div>
      </section>
      {canReadChannels ? (
        <CompanyTeamSection environmentId={primary.environmentId} projectId={primary.id} />
      ) : null}
      <CompanyRoutinesSection environmentId={primary.environmentId} projectId={primary.id} />
      <AgentLanes
        group={group}
        environmentId={primary.environmentId}
        onNewBridgeThread={(agent) => void startThread("", { kind: "bridge", agent })}
      />
      {canReadChannels ? (
        <CompanyChannelSections
          environmentId={primary.environmentId}
          projectId={primary.id}
          onAskAgent={(agent, prompt) => void startThread(prompt, { kind: "bridge", agent })}
        />
      ) : null}
      <section aria-labelledby="company-hub-brain" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 id="company-hub-brain" className="text-sm font-medium text-muted-foreground">
            Company brain
          </h2>
          <span className="text-xs text-muted-foreground">{COMPANY_DIR}/</span>
        </div>
        {canReadChannels ? <CompanyBrainSetup project={primary} /> : null}
        {canReadChannels ? (
          <CompanyBrainRecordsSection
            environmentId={primary.environmentId}
            projectId={primary.id}
          />
        ) : null}
        {brain.contents !== null ? (
          <div
            className={cn(
              "rounded-xl border border-border/60 bg-card px-4 py-3",
              brain.contents.trim().length === 0 && "text-muted-foreground",
            )}
          >
            <ChatMarkdown
              text={brain.contents}
              cwd={primary.workspaceRoot}
              environmentId={primary.environmentId}
            />
          </div>
        ) : null}
      </section>
      {canReadChannels ? <CompanyAccountsSetup project={primary} /> : null}
    </>
  );
}

function CompanyChannelSections(props: {
  readonly environmentId: SidebarProjectSnapshot["environmentId"];
  readonly projectId: ProjectId;
  readonly onAskAgent: (agent: BridgeAgent, prompt: string) => void;
}) {
  const target = { environmentId: props.environmentId, input: { projectId: props.projectId } };
  const accountsResult = useAtomValue(companyChannelEnvironment.accounts(target));
  const outboxResult = useAtomValue(companyChannelEnvironment.outbox(target));
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
    props.environmentId,
  );
  const [editingDraft, setEditingDraft] = useState<CompanyDraft | null>(null);
  const accounts = AsyncResult.getOrElse(accountsResult, () => null)?.accounts ?? [];
  const failureOf = (result: typeof accountsResult | typeof outboxResult) =>
    result._tag === "Failure" ? channelFailure(result.cause).message : null;

  return (
    <>
      <CompanyInboxSection
        environmentId={props.environmentId}
        projectId={props.projectId}
        accounts={accounts}
        agents={connectedBridgeAgents(providers ?? [])}
        onAskAgent={props.onAskAgent}
        onDraftCreated={setEditingDraft}
      />
      <CompanyOutboxSection
        environmentId={props.environmentId}
        projectId={props.projectId}
        accounts={accounts}
        outbox={AsyncResult.getOrElse(outboxResult, () => null)}
        error={failureOf(outboxResult)}
        editing={editingDraft}
        onEdit={setEditingDraft}
      />
    </>
  );
}

function AgentLanes({
  group,
  environmentId,
  onNewBridgeThread,
}: {
  group: SidebarProjectSnapshot;
  environmentId: SidebarProjectSnapshot["environmentId"];
  onNewBridgeThread: (agent: BridgeAgent) => void;
}) {
  const memberKeys = new Set(
    group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
  );
  const threads = useThreadShells().filter(
    (thread) =>
      thread.archivedAt === null && memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  );
  const providerEntries = useProviderEntryByEnvironmentAndInstanceId();
  const instanceIdOf = (thread: (typeof threads)[number]) =>
    thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const entryOf = (thread: (typeof threads)[number]) =>
    providerEntries.get(`${thread.environmentId}:${instanceIdOf(thread)}`);
  const lanes = groupThreadsByAgent(threads, (thread) => ({
    driverKind: entryOf(thread)?.driverKind ?? "unknown",
    instanceId: instanceIdOf(thread),
  }));
  const bridgeEntries = [...providerEntries].flatMap(([key, entry]) =>
    key.startsWith(`${environmentId}:`) && entry.driverKind === AGENT_BRIDGE_DRIVER ? [entry] : [],
  );
  const bridgeReady = bridgeEntries.some(isProviderInstancePickerReady);
  const providers = useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(
    environmentId,
  );
  const bridgeDocsUrl = bridgeEntries.find((entry) => entry.snapshot.setup?.documentationUrl)
    ?.snapshot.setup?.documentationUrl;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const navigate = useNavigate();

  return (
    <section aria-labelledby="company-hub-agents" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-agents" className="text-sm font-medium text-muted-foreground">
          Agents
        </h2>
        <div className="ml-auto flex flex-wrap gap-1">
          {connectedBridgeAgents(providers ?? []).map((agent) => (
            <Button
              key={agent.instanceId}
              size="sm"
              variant="outline"
              onClick={() => onNewBridgeThread(agent)}
            >
              <PlusIcon aria-hidden />
              New {agent.displayName} thread
            </Button>
          ))}
        </div>
      </div>
      {bridgeReady ? null : (
        <p className="text-sm text-muted-foreground">
          Connect Muse or Grok Bot in{" "}
          <Link
            to="/settings/providers"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings &gt; Providers
          </Link>{" "}
          to run outbound, email, social, and support work.
          {bridgeDocsUrl ? (
            <>
              {" "}
              <a
                href={bridgeDocsUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Setup guide
              </a>
            </>
          ) : null}
        </p>
      )}
      {lanes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No threads yet. Start work above, or start a thread from the sidebar.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {lanes.map((lane) => {
            const entry = lane.threads[0] ? entryOf(lane.threads[0]) : undefined;
            const showAll = expanded.has(lane.key);
            const shown = showAll ? lane.threads : lane.threads.slice(0, LANE_THREAD_LIMIT);
            return (
              <div
                key={lane.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-card p-3"
              >
                <div className="flex items-center gap-2">
                  {entry ? (
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind as ProviderDriverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      className="size-4"
                    />
                  ) : null}
                  <span className="text-sm font-medium">{entry?.displayName ?? lane.key}</span>
                  <span className="text-xs text-muted-foreground">
                    {lane.kind === "work" ? "Work" : "Code"} · {lane.threads.length}
                  </span>
                </div>
                <ul className="flex flex-col">
                  {shown.map((thread) => (
                    <li key={`${thread.environmentId}:${thread.id}`}>
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(thread.environmentId, thread.id),
                            ),
                          })
                        }
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ThreadRowLeadingStatus thread={thread} />
                        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatRelativeTimeLabel(thread.updatedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {lane.threads.length > LANE_THREAD_LIMIT ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      setExpanded((previous) => {
                        const next = new Set(previous);
                        if (showAll) next.delete(lane.key);
                        else next.add(lane.key);
                        return next;
                      })
                    }
                  >
                    {showAll ? "Show fewer" : `Show all ${lane.threads.length}`}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
