import { createConnectorEnvironmentAtoms } from "@t3tools/client-runtime/state/connectors";

import { connectionAtomRuntime } from "../connection/runtime";

export const connectorEnvironment = createConnectorEnvironmentAtoms(connectionAtomRuntime);
