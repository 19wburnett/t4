import { describe, expect, it } from "vite-plus/test";
import type { BrowserCredential } from "@t3tools/contracts";

import {
  filterSavedLogins,
  offersBrowserPasswordImport,
  parsePasswordCsv,
} from "./savedLogins.logic";

describe("offersBrowserPasswordImport", () => {
  it("offers import only from the desktop app into its own primary backend", () => {
    expect(offersBrowserPasswordImport(true, { _tag: "PrimaryConnectionTarget" })).toBe(true);
    expect(offersBrowserPasswordImport(false, { _tag: "PrimaryConnectionTarget" })).toBe(false);
    for (const _tag of [
      "BearerConnectionTarget",
      "RelayConnectionTarget",
      "SshConnectionTarget",
    ] as const) {
      expect(offersBrowserPasswordImport(true, { _tag })).toBe(false);
    }
    expect(offersBrowserPasswordImport(true, null)).toBe(false);
  });
});

describe("filterSavedLogins", () => {
  const login = (
    id: string,
    origin: string,
    username: string,
    sourceName: string,
  ): BrowserCredential => ({ id, origin, username, sourceName, source: "browser" });
  const logins = [
    login("a", "https://github.com", "octo@example.com", "Chrome (Default)"),
    login("b", "https://app.example.com:8443", "admin", "Personal vault"),
    login("c", "not a url", "", "Firefox (default-release)"),
  ];

  it("matches host, username, and source case-insensitively", () => {
    expect(filterSavedLogins(logins, "  GITHUB ").map((entry) => entry.id)).toEqual(["a"]);
    expect(filterSavedLogins(logins, "example.com").map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(filterSavedLogins(logins, ":8443").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterSavedLogins(logins, "vault").map((entry) => entry.id)).toEqual(["b"]);
    expect(filterSavedLogins(logins, "not a").map((entry) => entry.id)).toEqual(["c"]);
    expect(filterSavedLogins(logins, "https")).toEqual([]);
    expect(filterSavedLogins(logins, " ")).toBe(logins);
  });
});

describe("parsePasswordCsv", () => {
  it("reads Chrome and Safari exports, including quoted fields, CRLF and a BOM", () => {
    const chrome =
      "﻿name,url,username,password,note\r\n" +
      'github.com,https://github.com/login,octo,"p,a""ss",\r\n' +
      "empty,https://empty.example,someone,,\r\n" +
      "dup,https://github.com/login,octo,other,\r\n" +
      'multi,https://example.com,"line\nbreak",secret,"note, with comma"\r\n';
    expect(parsePasswordCsv(chrome)).toEqual([
      { origin: "https://github.com/login", username: "octo", password: 'p,a"ss' },
      { origin: "https://example.com", username: "line\nbreak", password: "secret" },
    ]);
    const safari = "Title,URL,Username,Password,Notes,OTPAuth\nApp,https://app.example,me,pw,,";
    expect(parsePasswordCsv(safari)).toEqual([
      { origin: "https://app.example", username: "me", password: "pw" },
    ]);
  });

  it("splits Bitwarden's multi-URI field and rejects files without url and password columns", () => {
    const bitwarden =
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n" +
      ',,login,Site,,,0,"https://a.example,https://b.example",me,pw,';
    expect(parsePasswordCsv(bitwarden)).toEqual([
      { origin: "https://a.example", username: "me", password: "pw" },
      { origin: "https://b.example", username: "me", password: "pw" },
    ]);
    expect(parsePasswordCsv("name,email\nAda,ada@example.com")).toBeNull();
    expect(parsePasswordCsv("")).toBeNull();
  });
});
