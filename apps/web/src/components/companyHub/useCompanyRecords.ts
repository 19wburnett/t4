import { CompanyBrainCollectionId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { companyBrainEnvironment } from "~/state/companyBrain";
import { useEnvironment } from "~/state/environments";
import { companyMachines, MACHINES_COLLECTION } from "./companyMachines.logic";

/** A collection's records, or none while loading or when the collection does not exist yet. */
export function useCompanyRecords(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  collection: string,
) {
  const listing = useAtomValue(
    companyBrainEnvironment.records({
      environmentId,
      input: { projectId, collection: CompanyBrainCollectionId.make(collection) },
    }),
  );
  return AsyncResult.getOrElse(listing, () => null)?.records ?? [];
}

/** The company's machine and the ones its brain lists, named as this client knows them. */
export function useCompanyMachines(environmentId: EnvironmentId, projectId: ProjectId) {
  const records = useCompanyRecords(environmentId, projectId, MACHINES_COLLECTION);
  const home = useEnvironment(environmentId);
  return companyMachines({
    home: { environmentId, name: home?.label ?? "This machine" },
    records,
  });
}
