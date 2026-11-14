import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { buildEmployeePrompt } from "@t3tools/shared/companyTeam";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";

import { newMessageId, newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProject } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { toastManager } from "../ui/toast";
import { resolveWorkTaskModelSelection } from "./companyHub.logic";
import { type Employee, employeeTargetOf } from "./companyTeam.logic";

const TITLE_LIMIT = 80;

/** A bot thread starts with its first message, so it carries the bot from its first event. */
export function useStartBotThread() {
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  return async (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    employee: Employee,
    instructions: string,
    task: string,
  ): Promise<boolean> => {
    const { environmentId } = project;
    const providers =
      appAtomRegistry.get(environmentPresentations.providersByEnvironmentAtom).get(environmentId) ??
      [];
    const resolved = resolveWorkTaskModelSelection(providers, employeeTargetOf(employee.provider));
    if ("warning" in resolved) {
      toastManager.add({
        type: "error",
        title: resolved.warning,
        description: `${employee.name} runs on ${employee.providerLabel}. Set it up in Settings > Providers.`,
      });
      return false;
    }
    const serverSettings =
      appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.settings ??
      DEFAULT_SERVER_SETTINGS;
    const { defaultRuntimeMode: runtimeMode } = resolveProjectSettings(
      serverSettings,
      project.id,
      readProject(scopeProjectRef(environmentId, project.id)) ?? undefined,
    ).settings;
    const threadId = newThreadId();
    const taskText = task.trim();
    const title =
      taskText.length > TITLE_LIMIT ? `${taskText.slice(0, TITLE_LIMIT - 1)}…` : taskText;
    const createdAt = new Date().toISOString();
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildEmployeePrompt(employee, instructions, taskText),
          attachments: [],
        },
        modelSelection: resolved.selection,
        runtimeMode,
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: project.id,
            title,
            modelSelection: resolved.selection,
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            bot: employee.recordId,
          },
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not start a thread with ${employee.name}`,
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
    return true;
  };
}
