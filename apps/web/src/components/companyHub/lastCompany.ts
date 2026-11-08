import * as Schema from "effect/Schema";

import { readLocalStorageValue, writeLocalStorageValue } from "~/hooks/useLocalStorage";

const LAST_COMPANY_KEY = "t3code:company-hub:last-project";
const LastCompany = Schema.NullOr(Schema.String);

/** The sidebar's Company button reopens the company you last worked in. */
export const readLastCompany = () => readLocalStorageValue(LAST_COMPANY_KEY, null, LastCompany);

export const rememberLastCompany = (projectKey: string) =>
  writeLocalStorageValue(LAST_COMPANY_KEY, projectKey, null, LastCompany);
