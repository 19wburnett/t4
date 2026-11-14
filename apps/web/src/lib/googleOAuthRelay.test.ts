import { describe, expect, it } from "vite-plus/test";

import { forwardUrl, parseRelayState } from "./googleOAuthRelay";

const state = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("parseRelayState", () => {
  it.each([
    [
      "a T4 server callback",
      { v: 1, r: "https://t4.example.test:8443/api/connectors/google/callback" },
      "t4.example.test:8443",
    ],
    [
      "a local dev server",
      { v: 1, r: "http://localhost:7085/api/connectors/google/callback" },
      "localhost:7085",
    ],
    ["any other path", { v: 1, r: "https://evil.test/steal" }, null],
    ["a non-web scheme", { v: 1, r: "javascript:alert(1)//api/connectors/google/callback" }, null],
    [
      "credentials in the URL",
      { v: 1, r: "https://a:b@t4.test/api/connectors/google/callback" },
      null,
    ],
    ["an unknown version", { v: 2, r: "https://t4.test/api/connectors/google/callback" }, null],
  ])("%s", (_name, value, host) => {
    expect(parseRelayState(state(value))?.host ?? null).toBe(host);
  });

  it("rejects garbage", () => {
    expect(parseRelayState("not-base64!")).toBeNull();
    expect(parseRelayState(null)).toBeNull();
  });
});

describe("forwardUrl", () => {
  it("carries the state, code, and error to the server", () => {
    const target = new URL("https://t4.test/api/connectors/google/callback");
    const forwarded = new URL(forwardUrl(target, { state: "s", code: "c&x", error: null }));
    expect(Object.fromEntries(forwarded.searchParams)).toEqual({ state: "s", code: "c&x" });
  });
});
