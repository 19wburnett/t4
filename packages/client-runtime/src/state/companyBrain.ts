import {
  type CompanyBrainCollectionId,
  type CompanyBrainRecordId,
  type EnvironmentId,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createCompanyBrainEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Agents edit records as files too, so listings go stale quickly.
  const collections = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-brain:collections",
    tag: WS_METHODS.companyBrainListCollections,
    staleTimeMs: 5_000,
  });
  const records = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-brain:records",
    tag: WS_METHODS.companyBrainListRecords,
    staleTimeMs: 5_000,
  });
  const record = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-brain:record",
    tag: WS_METHODS.companyBrainReadRecord,
    staleTimeMs: 5_000,
  });

  const source = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:company-brain:source",
    tag: WS_METHODS.companyBrainSourceStatus,
    staleTimeMs: 10_000,
  });
  // Pulling can change every record, so the whole brain reloads.
  const refreshSource = (
    {
      environmentId,
      input,
    }: { readonly environmentId: EnvironmentId; readonly input: { readonly projectId: ProjectId } },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(source({ environmentId, input: { projectId: input.projectId } }));
      registry.refresh(collections({ environmentId, input: { projectId: input.projectId } }));
    });

  type Target = {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly projectId: ProjectId;
      readonly collection: CompanyBrainCollectionId;
      readonly recordId?: CompanyBrainRecordId;
    };
  };
  const refresh = ({ environmentId, input }: Target, registry: AtomRegistry.AtomRegistry) =>
    Effect.sync(() => {
      registry.refresh(collections({ environmentId, input: { projectId: input.projectId } }));
      registry.refresh(
        records({
          environmentId,
          input: { projectId: input.projectId, collection: input.collection },
        }),
      );
      if (input.recordId !== undefined) {
        registry.refresh(
          record({
            environmentId,
            input: {
              projectId: input.projectId,
              collection: input.collection,
              recordId: input.recordId,
            },
          }),
        );
      }
    });

  return {
    collections,
    records,
    record,
    source,
    connect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-brain:connect",
      tag: WS_METHODS.companyBrainConnect,
      onSuccess: refreshSource,
    }),
    sync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-brain:sync",
      tag: WS_METHODS.companyBrainSync,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
      onSuccess: refreshSource,
    }),
    disconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-brain:disconnect",
      tag: WS_METHODS.companyBrainDisconnect,
      onSuccess: refreshSource,
    }),
    saveRecord: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-brain:save-record",
      tag: WS_METHODS.companyBrainSaveRecord,
      onSuccess: refresh,
    }),
    deleteRecord: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-brain:delete-record",
      tag: WS_METHODS.companyBrainDeleteRecord,
      onSuccess: refresh,
    }),
    saveCollection: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:company-brain:save-collection",
      tag: WS_METHODS.companyBrainSaveCollection,
      onSuccess: refresh,
    }),
  };
}
