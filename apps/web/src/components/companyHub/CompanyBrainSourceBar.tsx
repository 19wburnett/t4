import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { EllipsisIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { companyBrainEnvironment } from "~/state/companyBrain";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { brainFailure, describeBrainSource } from "./companyBrain.logic";

interface BrainTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** Clones a repo as company/ and says what happened to the files already there. */
export function useConnectBrainRepo() {
  const connect = useAtomCommand(companyBrainEnvironment.connect, { reportFailure: false });
  return async (target: BrainTarget, repository: string): Promise<string | null> => {
    const result = await connect({
      environmentId: target.environmentId,
      input: { projectId: target.projectId, repository },
    });
    if (result._tag !== "Success") return brainFailure(result.cause).message;
    const { kept, backupPath } = result.value;
    toastManager.add({
      type: "success",
      title: "Company brain connected",
      description:
        [
          kept > 0
            ? `${kept} file${kept === 1 ? "" : "s"} only here will go up on the next sync.`
            : null,
          backupPath
            ? `Your earlier versions of files the repo also has are saved in ${backupPath}.`
            : null,
        ]
          .filter((line) => line !== null)
          .join(" ") || undefined,
    });
    return null;
  };
}

export function CompanyBrainSourceBar(props: BrainTarget) {
  const result = useAtomValue(
    companyBrainEnvironment.source({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const canSync = useAtomValue(companyBrainEnvironment.sync.permissionAtom(props.environmentId));
  const sync = useAtomCommand(companyBrainEnvironment.sync, { reportFailure: false });
  const disconnect = useAtomCommand(companyBrainEnvironment.disconnect, {
    label: "disconnect brain repo",
  });
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const source = AsyncResult.getOrElse(result, () => null);
  if (source === null) return null;

  const runSync = async () => {
    setSyncing(true);
    const synced = await sync({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    });
    setSyncing(false);
    if (synced._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Could not sync the company brain",
        description: brainFailure(synced.cause).message,
      });
    }
  };

  const runDisconnect = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Stop syncing the company brain?\nThe files stay in company/. The repo is not changed.",
    );
    if (!confirmed) return;
    await disconnect({ environmentId: props.environmentId, input: { projectId: props.projectId } });
  };

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {source._tag === "git" ? <GitBranchIcon aria-hidden className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{describeBrainSource(source)}</span>
      {source._tag === "git" ? (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={!canSync || syncing}
            onClick={() => void runSync()}
          >
            {syncing ? <Spinner /> : <RefreshCwIcon aria-hidden />}
            Sync
          </Button>
          <Menu>
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Brain repo options" />}
            >
              <EllipsisIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={!canSync} onClick={() => void runDisconnect()}>
                Stop syncing
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      ) : (
        <Button size="xs" variant="ghost" disabled={!canSync} onClick={() => setConnecting(true)}>
          <GitBranchIcon aria-hidden />
          Sync with a repo
        </Button>
      )}
      {connecting ? <ConnectRepoDialog {...props} onClose={() => setConnecting(false)} /> : null}
    </div>
  );
}

function ConnectRepoDialog(props: BrainTarget & { readonly onClose: () => void }) {
  const connect = useConnectBrainRepo();
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sync the company brain with a repo</DialogTitle>
          <DialogDescription>
            T4 clones it as company/, and Sync commits, pulls, and pushes. Files only here are kept.
            Where the repo has a different version of a file, the repo's wins and yours is backed
            up.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-1.5">
            <Label htmlFor="brain-repo">Repository</Label>
            <Input
              id="brain-repo"
              placeholder="acme/brain or a git clone URL"
              value={repository}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setRepository(event.target.value)}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || repository.trim() === ""}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const failure = await connect(props, repository.trim());
              setBusy(false);
              if (failure === null) props.onClose();
              else setError(failure);
            }}
          >
            {busy ? <Spinner /> : null}
            Connect
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
