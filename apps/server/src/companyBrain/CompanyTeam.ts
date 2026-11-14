import {
  CompanyBrainCollectionId,
  type CompanyBrainRecordId,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  buildEmployeePrompt,
  type EmployeeProvider,
  employeeProviderOf,
  TEAM_COLLECTION,
} from "@t3tools/shared/companyTeam";
import * as Effect from "effect/Effect";

import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { loadCaller, resolveProjectId } from "../mcp/threadAccess.ts";
import * as CompanyBrain from "./CompanyBrain.ts";

const TEAM = CompanyBrainCollectionId.make(TEAM_COLLECTION);

/** Muse and Grok Bot are bridge instances; coding employees run on that driver's default. */
function employeeDelegateTarget(
  provider: EmployeeProvider,
): NonNullable<OrchestratorMcpDelegateTaskInput["target"]> {
  switch (provider) {
    case "muse":
      return { providerInstanceId: ProviderInstanceId.make("museBot") };
    case "grok":
      return { providerInstanceId: ProviderInstanceId.make("grokBot") };
    case "claude":
      return { driverKind: ProviderDriverKind.make("claudeAgent") };
    case "codex":
      return { driverKind: ProviderDriverKind.make("codex") };
  }
}

const TITLE_LIMIT = 80;

/** The thread is listed under the bot it was sent to, so its title is the ask. */
function messageTitle(message: string): string {
  const line = message.trim().split("\n")[0]!.trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

function teammateTask(from: string | null, message: string): string {
  const sender = from === null ? "A teammate" : `Your teammate ${from}`;
  return `${sender} asks:\n\n${message}\n\nWhen you finish, your final message goes back to them, so make it the answer.`;
}

/**
 * One bot messages another: the work runs as a task in a thread of the other bot, and its
 * final message wakes the sender's thread, as any delegated task does.
 */
export const messageBot = Effect.fn("CompanyTeam.messageBot")(function* (input: {
  readonly bot: CompanyBrainRecordId;
  readonly message: string;
}) {
  const caller = yield* loadCaller();
  const projectId = yield* resolveProjectId(caller, undefined);
  const brain = yield* CompanyBrain.CompanyBrain;
  const notFound = new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `No teammate "${input.bot}". List them with t3_brain_find, collection "${TEAM_COLLECTION}".`,
  });
  const record = yield* brain.readRecord({ projectId, collection: TEAM, recordId: input.bot }).pipe(
    Effect.catchTags({
      CompanyBrainError: (error) =>
        Effect.fail(
          error.reason === "unknown_record" || error.reason === "unknown_collection"
            ? notFound
            : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
    }),
  );
  const sender = caller.caller?.bot;
  if (sender === input.bot) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "That is you. Message a different teammate, or do the work in this thread.",
    });
  }
  const from =
    sender === undefined
      ? null
      : yield* brain.readRecord({ projectId, collection: TEAM, recordId: sender }).pipe(
          Effect.map((found) => found.title),
          Effect.orElseSucceed(() => null),
        );
  const role = record.fields.role;
  const service = yield* OrchestratorMcpService.OrchestratorMcpService;
  return yield* service.delegateTask(
    caller.scope,
    {
      task: buildEmployeePrompt(
        {
          name: record.title,
          role: typeof role === "string" && role.trim() !== "" ? role : record.title,
        },
        record.body,
        teammateTask(from, input.message),
      ),
      target: employeeDelegateTarget(employeeProviderOf(record.fields)),
      title: messageTitle(input.message),
    },
    { bot: input.bot },
  );
});
