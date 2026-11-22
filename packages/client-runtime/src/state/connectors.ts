import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createConnectorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:connectors:list",
    tag: WS_METHODS.connectorsList,
    staleTimeMs: 10_000,
  });
  const refreshList = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));
  return {
    list,
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:save",
      tag: WS_METHODS.connectorsSave,
      onSuccess: refreshList,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:remove",
      tag: WS_METHODS.connectorsRemove,
      onSuccess: refreshList,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:refresh",
      tag: WS_METHODS.connectorsRefresh,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.connectorId]),
      },
      onSuccess: refreshList,
    }),
    startGoogleSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:google-sign-in-start",
      tag: WS_METHODS.connectorsGoogleSignInStart,
    }),
    startOAuthSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:oauth-sign-in-start",
      tag: WS_METHODS.connectorsOAuthSignInStart,
    }),
    // Waits on the user in another tab; the connector appears once it resolves.
    waitForSignIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:connectors:sign-in-wait",
      tag: WS_METHODS.connectorsSignInWait,
      onSuccess: refreshList,
    }),
  };
}
