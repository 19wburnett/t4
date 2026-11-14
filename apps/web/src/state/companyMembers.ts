import { createCompanyMemberCommands } from "@t3tools/client-runtime/state/companyMembers";

import { connectionAtomRuntime } from "../connection/runtime";

export const companyMembers = createCompanyMemberCommands(connectionAtomRuntime);
