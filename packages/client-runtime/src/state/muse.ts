import { type MuseMessage, WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createMuseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "muse:list",
      tag: WS_METHODS.museList,
    }),
    thread: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "muse:thread",
      tag: WS_METHODS.museThread,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "muse:create",
      tag: WS_METHODS.museCreateThread,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "muse:send",
      tag: WS_METHODS.museSend,
    }),
    tokenStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "muse:token-status",
      tag: WS_METHODS.museBridgeTokenStatus,
    }),
    issueToken: createEnvironmentRpcCommand(runtime, {
      label: "muse:issue-token",
      tag: WS_METHODS.museBridgeTokenIssue,
    }),
    revokeToken: createEnvironmentRpcCommand(runtime, {
      label: "muse:revoke-token",
      tag: WS_METHODS.museBridgeTokenRevoke,
    }),
  };
}

export function groupMuseMessages(messages: ReadonlyArray<MuseMessage>) {
  const exchanges = new Map<
    string,
    {
      message: MuseMessage;
      activity: MuseMessage[];
      reply: MuseMessage | undefined;
    }
  >();
  for (const message of messages) {
    if (message.direction === "inbound") {
      exchanges.set(message.id, { message, activity: [], reply: undefined });
    }
  }
  for (const message of messages) {
    if (message.inReplyTo === null) continue;
    const exchange = exchanges.get(message.inReplyTo);
    if (!exchange) continue;
    if (message.replyKind === "ack" || message.replyKind === "progress") {
      exchange.activity.push(message);
    } else {
      exchange.reply = message;
    }
  }
  return [...exchanges.values()];
}

export function hasPendingMuseMessages(messages: ReadonlyArray<MuseMessage> | undefined) {
  return messages?.some(({ status }) => status === "queued" || status === "claimed") ?? false;
}
