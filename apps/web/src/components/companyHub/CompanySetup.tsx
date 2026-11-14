import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { DownloadIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { companyChannelEnvironment } from "~/state/companyChannels";
import { useEnvironmentScope } from "~/state/session";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { getProjectFileQueryAtom } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { CompanyBrainSourceBar, useConnectBrainRepo } from "./CompanyBrainSourceBar";
import { channelFailure } from "./companyChannels.logic";
import { CompanyChannelsSection } from "./CompanyChannelsSection";
import {
  type BrainSource,
  brainSourceLabel,
  buildBrainImportPrompt,
  COMPANY_BRAIN_TEMPLATES,
  COMPANY_DIR,
  isStarterBrain,
  parseBrainSource,
} from "./companyHub.logic";
import { useStartWorkThread } from "./useStartWorkThread";
import { useWriteCompanyBrain } from "./useWriteCompanyBrain";

type CompanyProject = SidebarProjectSnapshot["memberProjects"][number] | SidebarProjectSnapshot;

/** Company setup and the hub both act on the group's first member, like the sidebar's new-thread button. */
export const companyProjectOf = (group: SidebarProjectSnapshot): CompanyProject =>
  group.memberProjects[0] ?? group;

export function useCompanyBrainFile(project: CompanyProject) {
  const atom = getProjectFileQueryAtom(
    project.environmentId,
    project.workspaceRoot,
    COMPANY_BRAIN_TEMPLATES[0]!.relativePath,
  );
  const result = useAtomValue(atom);
  const file = AsyncResult.getOrElse(result, () => null);
  return {
    loading: result._tag === "Initial",
    contents: file !== null && file.exists !== false ? file.contents : null,
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

/** Email and social accounts the company sends from. */
export function CompanyAccountsSetup({ project }: { readonly project: CompanyProject }) {
  const result = useAtomValue(
    companyChannelEnvironment.accounts({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  return (
    <CompanyChannelsSection
      environmentId={project.environmentId}
      projectId={project.id}
      accounts={AsyncResult.getOrElse(result, () => null)?.accounts ?? []}
      loading={result._tag === "Initial"}
      error={result._tag === "Failure" ? channelFailure(result.cause).message : null}
    />
  );
}

/** Create, import, or connect the brain, and where it syncs. */
export function CompanyBrainSetup({ project }: { readonly project: CompanyProject }) {
  const brain = useCompanyBrainFile(project);
  const canWriteFiles = useEnvironmentScope(project.environmentId, AuthFilesystemWriteScope);
  const writeCompanyBrain = useWriteCompanyBrain();
  const connectRepo = useConnectBrainRepo();
  const startWorkThread = useStartWorkThread();
  const [busy, setBusy] = useState(false);

  const createBrain = async (): Promise<boolean> => {
    setBusy(true);
    const written = await writeCompanyBrain({
      environmentId: project.environmentId,
      workspaceRoot: project.workspaceRoot,
    });
    setBusy(false);
    if (written) brain.refresh();
    return written;
  };

  // A GitHub brain stays where it is and syncs; other sources are read once by an agent.
  const importBrain = async (source: BrainSource) => {
    if (source.kind === "github") {
      setBusy(true);
      const failure = await connectRepo(
        { environmentId: project.environmentId, projectId: project.id },
        source.repository,
      );
      setBusy(false);
      if (failure !== null) {
        toastManager.add({
          type: "error",
          title: "Could not connect the repo",
          description: failure,
        });
      }
      brain.refresh();
      return;
    }
    // The agent fills the starter headings, so a missing brain gets them first.
    if (brain.contents === null && !(await createBrain())) return;
    void startWorkThread(project, buildBrainImportPrompt(source), {
      kind: "coding",
      provider: "claude",
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <CompanyBrainSourceBar environmentId={project.environmentId} projectId={project.id} />
      {brain.loading ? null : brain.contents === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Who you are, who you sell to, your voice, and your channels, in {COMPANY_DIR}/. Every
            agent reads it before it starts work.
          </p>
          <Button size="sm" disabled={!canWriteFiles || busy} onClick={() => void createBrain()}>
            Create company brain
          </Button>
        </div>
      ) : null}
      {brain.contents === null || isStarterBrain(brain.contents) ? (
        <ImportBrainForm disabled={!canWriteFiles || busy} onImport={importBrain} />
      ) : null}
    </div>
  );
}

function ImportBrainForm(props: {
  disabled: boolean;
  onImport: (source: BrainSource) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const source = parseBrainSource(value);
  const invalid = value.trim().length > 0 && source === null;

  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (source) void props.onImport(source);
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        Already have a company brain?
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          className="min-w-0 flex-1"
          size="sm"
          placeholder="acme.com, github.com/acme/brain, or a Supabase project URL"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
        />
        <Button type="submit" size="sm" disabled={props.disabled || source === null}>
          <DownloadIcon aria-hidden />
          Import
        </Button>
      </div>
      <p className={cn("text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid
          ? "Paste a website, a GitHub repo, or a Supabase project URL."
          : source
            ? source.kind === "github"
              ? `T4 clones ${source.repository} as ${COMPANY_DIR}/ and keeps it in sync.`
              : `Claude reads the ${brainSourceLabel(source)} and fills in ${COMPANY_DIR}/. You review the prompt before it starts.`
            : `Claude reads it and fills in ${COMPANY_DIR}/ for every agent here.`}
      </p>
    </form>
  );
}
