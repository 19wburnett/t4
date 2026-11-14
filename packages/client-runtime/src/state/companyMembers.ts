/**
 * Company members on one environment: an invite is a pairing link bound to the member, minted
 * there with the admin's own session, and removing a member revokes every session and unused
 * link that carries their subject. Both use the environment's existing auth endpoints.
 */
import {
  type AuthAccessSnapshot,
  type AuthGrantScope,
  type AuthSessionId,
  companyMemberSubject,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

const REQUEST_TIMEOUT_MS = 8_000;

export class CompanyMemberAccessError extends Data.TaggedError("CompanyMemberAccessError")<{
  readonly reason: "not_allowed" | "unavailable";
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.reason === "not_allowed"
      ? "Only an admin of this machine can invite or remove teammates."
      : "Could not reach this machine. Check that it is online and try again.";
  }
}

export interface CompanyMemberInvite {
  readonly credential: string;
  /** The address the invited browser pairs with. */
  readonly host: string;
}

/** What a member holds on this environment: their sessions and unused invites. */
export function memberAccess(snapshot: AuthAccessSnapshot, memberId: string) {
  const subject = companyMemberSubject(memberId);
  return {
    sessions: snapshot.clientSessions.filter((session) => session.subject === subject),
    pairingLinks: snapshot.pairingLinks.filter((link) => link.subject === subject),
  };
}

const toAccessError = (cause: { readonly _tag: string }) =>
  new CompanyMemberAccessError({
    reason:
      cause._tag === "EnvironmentScopeRequiredError" ||
      cause._tag === "EnvironmentOperationForbiddenError"
        ? "not_allowed"
        : "unavailable",
    cause,
  });

const connected = Effect.fn("clientRuntime.state.companyMembers.connected")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) {
    return yield* new CompanyMemberAccessError({
      reason: "unavailable",
      cause: "The environment is not connected.",
    });
  }
  return {
    prepared: prepared.value,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
  };
});

const invite = Effect.fn("clientRuntime.state.companyMembers.invite")(function* (input: {
  readonly memberId: string;
  readonly label: string;
  /** Omitted: what a member gets. An admin's invite passes the owner's standard scopes. */
  readonly scopes?: ReadonlyArray<AuthGrantScope>;
}): Effect.fn.Return<
  CompanyMemberInvite,
  CompanyMemberAccessError,
  EnvironmentSupervisor.EnvironmentSupervisor | HttpClient.HttpClient
> {
  const connection = yield* connected();
  const minted = yield* executeAuthenticatedEnvironmentHttpRequest({
    ...connection,
    group: "auth",
    method: "POST",
    url: (urls) => urls.pairingCredential(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.pairingCredential({
        headers,
        payload: {
          label: input.label,
          memberId: input.memberId,
          ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        },
      }),
  }).pipe(Effect.mapError(toAccessError));
  return { credential: minted.credential, host: hostOf(connection.prepared) };
});

const revoke = Effect.fn("clientRuntime.state.companyMembers.revoke")(function* (input: {
  readonly sessionIds: ReadonlyArray<AuthSessionId>;
  readonly pairingLinkIds: ReadonlyArray<string>;
}) {
  const connection = yield* connected();
  for (const id of input.pairingLinkIds) {
    yield* executeAuthenticatedEnvironmentHttpRequest({
      ...connection,
      group: "auth",
      method: "POST",
      url: (urls) => urls.revokePairingLink(),
      timeoutMs: REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) => client.revokePairingLink({ headers, payload: { id } }),
    }).pipe(Effect.mapError(toAccessError));
  }
  for (const sessionId of input.sessionIds) {
    yield* executeAuthenticatedEnvironmentHttpRequest({
      ...connection,
      group: "auth",
      method: "POST",
      url: (urls) => urls.revokeClient(),
      timeoutMs: REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) => client.revokeClient({ headers, payload: { sessionId } }),
    }).pipe(Effect.mapError(toAccessError));
  }
});

function hostOf(prepared: PreparedConnection): string {
  return new URL(prepared.httpBaseUrl).origin;
}

export function createCompanyMemberCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    invite: createEnvironmentCommand(runtime, {
      label: "environment-data:company-member:invite",
      execute: invite,
    }),
    revoke: createEnvironmentCommand(runtime, {
      label: "environment-data:company-member:revoke",
      execute: revoke,
    }),
  };
}
