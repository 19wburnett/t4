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
