import { createCompanyBrainEnvironmentAtoms } from "@t3tools/client-runtime/state/companyBrain";

import { connectionAtomRuntime } from "../connection/runtime";

export const companyBrainEnvironment = createCompanyBrainEnvironmentAtoms(connectionAtomRuntime);
