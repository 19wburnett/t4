import { createAuthEnvironmentAtoms } from "@t3tools/client-runtime/state/auth";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";

export const authEnvironment = createAuthEnvironmentAtoms(connectionAtomRuntime);

/** Each listed environment's access list, for work that spans the company's machines. */
export const authAccessListAtom = environmentAtomList("web-auth-access-list", (environmentId) =>
  authEnvironment.accessChanges({ environmentId, input: null }),
);
