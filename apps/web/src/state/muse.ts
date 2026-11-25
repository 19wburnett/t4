import { createMuseEnvironmentAtoms } from "@t3tools/client-runtime/state/muse";

import { connectionAtomRuntime } from "../connection/runtime";

export const museEnvironment = createMuseEnvironmentAtoms(connectionAtomRuntime);
