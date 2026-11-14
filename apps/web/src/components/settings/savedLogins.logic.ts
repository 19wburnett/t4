import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  BROWSER_CREDENTIAL_MAX_IMPORT_ENTRIES,
  type BrowserCredential,
  BrowserCredentialImportEntry,
  type BrowserCredentialManager,
  type BrowserCredentialManagerStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Decrypted browser passwords may only reach the desktop's own backend, never a remote one. */
export function offersBrowserPasswordImport(
  hasDesktopBridge: boolean,
  target: Pick<ConnectionTarget, "_tag"> | null,
): boolean {
  return hasDesktopBridge && target?._tag === "PrimaryConnectionTarget";
}

export function savedLoginHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function filterSavedLogins(
  credentials: ReadonlyArray<BrowserCredential>,
  query: string,
): ReadonlyArray<BrowserCredential> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return credentials;
  return credentials.filter((credential) =>
    [savedLoginHost(credential.origin), credential.username, credential.sourceName].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

const MANAGER_STATUS_COPY: Readonly<
  Record<BrowserCredentialManager, Readonly<Record<BrowserCredentialManagerStatus, string>>>
> = {
  one_password: {
    not_installed: "Install the 1Password CLI (op) on the host.",
    signed_out: "Run op signin on the host.",
    locked: "Run op signin on the host.",
    ready: "Ready. Logins are read live from 1Password when an agent fills them.",
  },
  bitwarden: {
    not_installed: "Install the Bitwarden CLI (bw) on the host.",
    signed_out: "Run bw login on the host.",
    locked: "Locked. Unlock with your master password.",
    ready: "Unlocked until the server restarts or you lock it.",
  },
};

export function passwordManagerStatusCopy(
  manager: BrowserCredentialManager,
  status: BrowserCredentialManagerStatus,
): string {
  return MANAGER_STATUS_COPY[manager][status];
}

function parseCsv(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = [];
  let row: Array<string> = [];
  let field = "";
  let quoted = false;
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Chrome, Edge, Safari, Firefox, 1Password and LastPass use url/username/password; Bitwarden prefixes login_.
const CSV_COLUMNS = {
  url: ["url", "login_uri", "website", "login url"],
  username: ["username", "login_username", "user name", "login"],
  password: ["password", "login_password"],
} as const;

const isImportEntry = Schema.is(BrowserCredentialImportEntry);

/** Reads a password-manager CSV export; null when it has no url and password columns. */
export function parsePasswordCsv(text: string): ReadonlyArray<BrowserCredentialImportEntry> | null {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) return null;
  const names = header.map((name) => name.trim().toLowerCase());
  const column = (aliases: ReadonlyArray<string>) =>
    aliases.map((alias) => names.indexOf(alias)).find((index) => index >= 0);
  const url = column(CSV_COLUMNS.url);
  const username = column(CSV_COLUMNS.username);
  const password = column(CSV_COLUMNS.password);
  if (url === undefined || password === undefined) return null;
  const entries = new Map<string, BrowserCredentialImportEntry>();
  for (const row of rows) {
    const secret = row[password] ?? "";
    if (secret === "") continue;
    const name = username === undefined ? "" : (row[username] ?? "");
    // Bitwarden puts every URI of an item into one field, separated by commas.
    for (const origin of (row[url] ?? "").split(/[,\n]/)) {
      const entry = { origin: origin.trim(), username: name, password: secret };
      const key = JSON.stringify([entry.origin, name]);
      if (entry.origin !== "" && !entries.has(key) && isImportEntry(entry)) entries.set(key, entry);
    }
  }
  return [...entries.values()].slice(0, BROWSER_CREDENTIAL_MAX_IMPORT_ENTRIES);
}
