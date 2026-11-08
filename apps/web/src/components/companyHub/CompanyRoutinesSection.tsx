import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { PlayIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope } from "~/state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import {
  COMPANY_ROUTINE_PRESETS,
  type CompanyRoutinePreset,
  routineScheduleLabel,
} from "./companyRoutines.logic";

/** Routines are scheduled tasks, so they reuse the same runner, model, and history. */
export function CompanyRoutinesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(props.environmentId),
  );
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "add routine",
  });
  const toggleTask = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "routine enabled",
  });
  const runTask = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "run routine now",
  });
  const settings = useEnvironmentSettings(props.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const [busy, setBusy] = useState(false);

  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => task.projectId === props.projectId);
  const permitted = () => readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);

  const add = async (preset: CompanyRoutinePreset) => {
    if (busy) return;
    if (!permitted()) {
      toastManager.add({ type: "error", title: "You cannot create routines here." });
      return;
    }
    const selection = scheduledTaskDefaultModel(
      settings,
      { id: props.projectId },
      providerInstanceEntriesFor(providers, settings, props.projectId),
    );
    if (selection === null) {
      toastManager.add({
        type: "error",
        title: "No model is available",
        description: "Connect a provider in Settings > Providers, then add the routine again.",
      });
      return;
    }
    setBusy(true);
    const result = await upsertTask({
      environmentId: props.environmentId,
      input: {
        title: preset.title,
        prompt: preset.prompt,
        enabled: true,
        schedule: {
          type: "fixed_time",
          timeOfDay: preset.timeOfDay,
          ...(preset.weekdays === undefined ? {} : { weekdays: [...preset.weekdays] }),
        },
        projectId: props.projectId,
        workspaceStrategy: { type: "root" },
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        creationSource: "web",
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not add the routine",
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  const act = async (action: "toggle" | "run", id: ScheduledTaskId, enabled: boolean) => {
    if (busy || !permitted()) return;
    setBusy(true);
    const result =
      action === "toggle"
        ? await toggleTask({
            environmentId: props.environmentId,
            input: { id, enabled: !enabled },
          })
        : await runTask({ environmentId: props.environmentId, input: { id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not update the routine",
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  const available = COMPANY_ROUTINE_PRESETS.filter(
    (preset) => !tasks.some((task) => task.title === preset.title),
  );

  return (
    <section aria-labelledby="company-hub-routines" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="company-hub-routines" className="text-sm font-medium text-muted-foreground">
          Routines
        </h2>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                disabled={!canOperate || busy || available.length === 0}
              />
            }
          >
            <PlusIcon aria-hidden />
            Add routine
          </MenuTrigger>
          <MenuPopup align="end">
            {available.map((preset) => (
              <MenuItem key={preset.id} onClick={() => void add(preset)}>
                <span className="flex min-w-0 flex-col">
                  <span>{preset.label}</span>
                  <span className="text-xs text-muted-foreground">{preset.description}</span>
                </span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      </div>
      {tasksQuery.error ? (
        <p role="alert" className="text-sm text-destructive">
          {tasksQuery.error}
        </p>
      ) : tasksQuery.data === null || tasksQuery.data === undefined ? null : tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Recurring work that runs on its own: inbox triage, pipeline follow-ups, metrics, and
          investor updates. Add one and it runs on this machine on its schedule.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50 rounded-xl border border-border/60 bg-card">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{task.title}</span>
                <span className="text-xs text-muted-foreground">
                  {routineScheduleLabel(task.schedule)}
                  {task.enabled ? "" : " · Paused"}
                </span>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Run ${task.title} now`}
                disabled={busy || !canOperate}
                onClick={() => void act("run", task.id, task.enabled)}
              >
                <PlayIcon />
              </Button>
              <Switch
                checked={task.enabled}
                disabled={busy || !canOperate}
                aria-label={`Enable ${task.title}`}
                onCheckedChange={() => void act("toggle", task.id, task.enabled)}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Each run starts a thread in this company.{" "}
        <Link to="/settings/scheduled-tasks" className="underline underline-offset-2">
          Edit routines in Scheduled tasks
        </Link>
        .
      </p>
    </section>
  );
}
