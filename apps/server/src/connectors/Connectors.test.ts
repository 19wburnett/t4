import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorSaveInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { connectWith, type ConnectorTarget } from "./connectorClient.ts";
import * as Connectors from "./Connectors.ts";
import { GOOGLE_CLIENT_ID, pkceChallenge } from "./google/googleOAuth.ts";

const TOKEN = "Bearer good-token";

interface FakeTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly properties?: object };
  readonly annotations?: { readonly readOnlyHint: boolean };
}

const MCP_URL = "https://mcp.example.test/mcp";
const MCP_ORIGIN = new URL(MCP_URL).origin;

/** The sign-in service of an MCP server that takes any client, faked at the fetch boundary. */
const fakeOAuthServer = () => {
  const challenges = new Map<string, string>();
  const registrations: Array<{ readonly redirect_uris: ReadonlyArray<string> }> = [];
  let issued = 0;
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const issue = () => {
    issued += 1;
    accessToken = `oauth-access-${issued}`;
    refreshToken = `oauth-refresh-${issued}`;
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== MCP_ORIGIN) return json({}, 404);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: MCP_ORIGIN,
        authorization_endpoint: `${MCP_ORIGIN}/authorize`,
        token_endpoint: `${MCP_ORIGIN}/token`,
        registration_endpoint: `${MCP_ORIGIN}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/register") {
      const body = JSON.parse(String(init?.body)) as { redirect_uris: ReadonlyArray<string> };
      registrations.push(body);
      return json({ ...body, client_id: "t4-client" }, 201);
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "refresh_token") {
        return refreshToken !== null && body.get("refresh_token") === refreshToken
          ? issue()
          : json({ error: "invalid_grant" }, 400);
      }
      const challenge = challenges.get(body.get("code") ?? "");
      return challenge === (await pkceChallenge(body.get("code_verifier") ?? ""))
        ? issue()
        : json({ error: "invalid_grant" }, 400);
    }
    return json({}, 404);
  };
  return {
    fetch,
    registrations,
    validAccessToken: () => accessToken,
    /** The service sends the browser back with a code tied to the sign-in's PKCE challenge. */
    approve: (authUrl: string, code: string) => {
      challenges.set(code, new URL(authUrl).searchParams.get("code_challenge") ?? "");
    },
    expireAccessToken: () => {
      accessToken = null;
    },
    revoke: () => {
      accessToken = null;
      refreshToken = null;
    },
  };
};

/** An in-memory MCP server that wants `TOKEN`, or a signed-in client, and records what it is asked. */
const upstream = (oauth: ReturnType<typeof fakeOAuthServer>) => {
  const opened: Array<ConnectorTarget> = [];
  const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
  let tools: ReadonlyArray<FakeTool> = [
    {
      name: "create_issue",
      description: "Create an issue",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    },
    {
      name: "list_issues",
      description: "List issues",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ];
  let reachable = true;
  const open = async (target: ConnectorTarget) => {
    opened.push(target);
    if (!reachable) throw new TypeError("fetch failed");
    const provider = target.authProvider;
    if (provider !== undefined) {
      // What the SDK's HTTP transport does when the server answers 401.
      if ((await provider.tokens())?.access_token !== oauth.validAccessToken()) {
        const result = await auth(provider, { serverUrl: target.url, fetchFn: oauth.fetch });
        if (result !== "AUTHORIZED") throw new UnauthorizedError();
      }
    } else if (target.headers["Authorization"] !== TOKEN) {
      throw Object.assign(new Error("Unauthorized"), { code: 401 });
    }
    const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      calls.push({ name: request.params.name, args: request.params.arguments });
      return { content: [{ type: "text", text: `ran ${request.params.name}` }] };
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    return connectWith(clientSide);
  };
  return {
    open,
    opened,
    calls,
    setTools: (next: ReadonlyArray<FakeTool>) => {
      tools = next;
    },
    setReachable: (next: boolean) => {
      reachable = next;
    },
  };
};

const GOOGLE_BROKER = "https://broker.example.test";

/** Google and T4's hosted token endpoint, faked at the fetch boundary. */
const fakeGoogle = () => {
  const challenges = new Map<string, string>();
  const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  let accessTokenNumber = 0;
  let rejectAccessToken: string | null = null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ url: url.href, authorization });
    if (url.href === `${GOOGLE_BROKER}/api/google/token`) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.grant_type === "refresh_token") {
        if (body.refresh_token !== "refresh-1") return json({ error: "invalid_grant" }, 400);
        return json({ access_token: `access-${++accessTokenNumber}`, expires_in: 3600 });
      }
      const challenge = challenges.get(body.code ?? "");
      if (challenge !== (await pkceChallenge(body.code_verifier ?? ""))) {
        return json({ error: "invalid_grant", error_description: "Bad verifier." }, 400);
      }
      return json({
        access_token: `access-${++accessTokenNumber}`,
        expires_in: 3600,
        refresh_token: "refresh-1",
      });
    }
    if (authorization === `Bearer ${rejectAccessToken}`) return json({}, 401);
    if (url.pathname === "/gmail/v1/users/me/profile") {
      return json({ emailAddress: "ana@example.test" });
    }
    if (url.pathname === "/gmail/v1/users/me/messages") return json({ messages: [] });
    return json({ error: { message: "Not found" } }, 404);
  };
  return {
    broker: { url: GOOGLE_BROKER, fetch },
    requests,
    /** Google sends the browser back with a code tied to the sign-in's PKCE challenge. */
    approve: (authUrl: string, code: string) => {
      challenges.set(code, new URL(authUrl).searchParams.get("code_challenge") ?? "");
    },
    rejectAccessToken: (token: string) => {
      rejectAccessToken = token;
    },
  };
};

const withConnectors = <A, E>(
  use: (input: {
    readonly connectors: Connectors.Connectors["Service"];
    readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
    readonly fake: ReturnType<typeof upstream>;
    readonly google: ReturnType<typeof fakeGoogle>;
    readonly oauth: ReturnType<typeof fakeOAuthServer>;
    readonly stateDir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const oauth = fakeOAuthServer();
    const fake = upstream(oauth);
    const google = fakeGoogle();
    const layer = Connectors.layerWith({
      open: fake.open,
      google: google.broker,
      oauthFetch: oauth.fetch,
    }).pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-connectors-state-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const connectors = yield* Connectors.Connectors;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      return yield* use({ connectors, secrets, fake, google, oauth, stateDir });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const linear: ConnectorSaveInput = {
  name: "Linear",
  url: MCP_URL,
  auth: { _tag: "header", name: "Authorization", value: Redacted.make(TOKEN) },
};

describe("Connectors", () => {
  it.effect("saves a working connector with its tools and keeps the header off the record", () =>
    withConnectors(({ connectors, fake, stateDir }) =>
      Effect.gen(function* () {
        const saved = yield* connectors.save(linear);
        expect(saved.id).toMatch(/^linear-[0-9a-f]{4}$/);
        expect(saved.tools).toEqual([
          { name: "create_issue", description: "Create an issue", readOnly: false },
          { name: "list_issues", description: "List issues", readOnly: true },
        ]);
        expect(fake.opened[0]?.headers).toEqual({ Authorization: TOKEN });
        expect(yield* connectors.list).toEqual([saved]);
        const file = yield* (yield* FileSystem.FileSystem).readFileString(
          `${stateDir}/connectors.json`,
        );
        expect(file).not.toContain("good-token");
      }),
    ),
  );

  it.effect("refuses to save a connector whose server rejects the credentials", () =>
    withConnectors(({ connectors }) =>
      Effect.gen(function* () {
        const error = yield* connectors
          .save({
            ...linear,
            auth: { _tag: "header", name: "Authorization", value: Redacted.make("Bearer bad") },
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("auth_failed");
        expect(yield* connectors.list).toEqual([]);
      }),
    ),
  );

  it.effect("keeps the saved header when an edit leaves it out", () =>
    withConnectors(({ connectors, fake }) =>
      Effect.gen(function* () {
        const saved = yield* connectors.save(linear);
        const renamed = yield* connectors.save({
          connectorId: saved.id,
          name: "Linear (work)",
          url: linear.url,
          auth: { _tag: "header", name: "Authorization" },
        });
        expect(renamed.id).toBe(saved.id);
        expect(fake.opened.at(-1)?.headers).toEqual({ Authorization: TOKEN });
      }),
    ),
  );

  it.effect("forwards a call to the server and refuses tools it does not list", () =>
    withConnectors(({ connectors, fake }) =>
      Effect.gen(function* () {
        const saved = yield* connectors.save(linear);
        const result = yield* connectors.callTool(saved.id, "create_issue", { title: "Bug" });
        expect(result).toEqual({
          content: [{ type: "text", text: "ran create_issue" }],
          isError: false,
        });
        expect(fake.calls).toEqual([{ name: "create_issue", args: { title: "Bug" } }]);
        const unknown = yield* connectors.callTool(saved.id, "delete_all", {}).pipe(Effect.flip);
        expect(unknown.reason).toBe("unknown_tool");
        expect(fake.calls).toHaveLength(1);
      }),
    ),
  );

  it.effect("records an unreachable server on refresh and clears it once it answers", () =>
    withConnectors(({ connectors, fake }) =>
      Effect.gen(function* () {
        const saved = yield* connectors.save(linear);
        fake.setReachable(false);
        const failed = yield* connectors.refresh(saved.id);
        expect(failed.health._tag).toBe("error");
        expect(failed.tools).toEqual(saved.tools);
        fake.setReachable(true);
        fake.setTools([{ name: "search", description: "Search", inputSchema: { type: "object" } }]);
        const refreshed = yield* connectors.refresh(saved.id);
        expect(refreshed.health).toEqual({ _tag: "ok" });
        expect(refreshed.tools.map((tool) => tool.name)).toEqual(["search"]);
      }),
    ),
  );

  it.effect("removes a connector with its credentials", () =>
    withConnectors(({ connectors, secrets }) =>
      Effect.gen(function* () {
        const saved = yield* connectors.save(linear);
        expect(yield* connectors.remove(saved.id)).toBe(true);
        expect(yield* connectors.list).toEqual([]);
        const error = yield* connectors.callTool(saved.id, "list_issues", {}).pipe(Effect.flip);
        expect(error.reason).toBe("unknown_connector");
        expect((yield* secrets.get(`connector-${saved.id}`))._tag).toBe("None");
      }),
    ),
  );

  it.effect("connects Google through the PKCE exchange and keeps the refresh token secret", () =>
    withConnectors(({ connectors, google, secrets, stateDir }) =>
      Effect.gen(function* () {
        const started = yield* connectors.googleSignInStart("https://t4.example.test:8443/");
        const authUrl = new URL(started.authUrl);
        expect(authUrl.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
        expect(authUrl.searchParams.get("redirect_uri")).toBe(
          `${GOOGLE_BROKER}/api/google/callback`,
        );
        const state = JSON.parse(Buffer.from(started.state, "base64url").toString("utf8")) as {
          r: string;
        };
        expect(state.r).toBe("https://t4.example.test:8443/api/connectors/google/callback");

        google.approve(started.authUrl, "code-1");
        const waiting = yield* connectors.signInWait(started.state).pipe(Effect.forkChild);
        const finished = yield* connectors.signInFinish({
          state: started.state,
          code: "code-1",
          error: undefined,
        });
        expect(finished.source).toEqual({ _tag: "google", email: "ana@example.test" });
        expect(finished.tools.map((tool) => tool.name)).toContain("gmail_search");
        expect(yield* Fiber.join(waiting)).toEqual(finished);

        const secret = yield* secrets.get(`connector-${finished.id}`);
        expect(secret._tag === "Some" && new TextDecoder().decode(secret.value)).toBe("refresh-1");
        const file = yield* (yield* FileSystem.FileSystem).readFileString(
          `${stateDir}/connectors.json`,
        );
        expect(file).not.toContain("refresh-1");

        const replay = yield* connectors
          .signInFinish({ state: started.state, code: "code-1", error: undefined })
          .pipe(Effect.flip);
        expect(replay.reason).toBe("sign_in_expired");
      }),
    ),
  );

  it.effect("connects a server through its own sign-in page and keeps the tokens secret", () =>
    withConnectors(({ connectors, fake, oauth, secrets, stateDir }) =>
      Effect.gen(function* () {
        const started = yield* connectors.oauthSignInStart({
          name: "Linear",
          url: MCP_URL,
          httpBaseUrl: "https://t4.example.test:8443/",
        });
        const callback = "https://t4.example.test:8443/api/connectors/oauth/callback";
        expect(oauth.registrations.map((client) => client.redirect_uris)).toEqual([[callback]]);
        const authUrl = new URL(started.authUrl);
        expect(authUrl.origin + authUrl.pathname).toBe(`${MCP_ORIGIN}/authorize`);
        expect(authUrl.searchParams.get("client_id")).toBe("t4-client");
        expect(authUrl.searchParams.get("redirect_uri")).toBe(callback);
        expect(authUrl.searchParams.get("state")).toBe(started.state);
        expect(yield* connectors.list).toEqual([]);

        oauth.approve(started.authUrl, "code-1");
        const waiting = yield* connectors.signInWait(started.state).pipe(Effect.forkChild);
        const finished = yield* connectors.signInFinish({
          state: started.state,
          code: "code-1",
          error: undefined,
        });
        expect(finished.source).toEqual({ _tag: "mcp", url: MCP_URL, auth: { _tag: "oauth" } });
        expect(finished.tools.map((tool) => tool.name)).toEqual(["create_issue", "list_issues"]);
        expect(yield* Fiber.join(waiting)).toEqual(finished);
        expect(fake.opened.at(-1)?.headers).toEqual({});

        const file = yield* (yield* FileSystem.FileSystem).readFileString(
          `${stateDir}/connectors.json`,
        );
        expect(file).not.toContain("oauth-access-1");
        expect(file).not.toContain("oauth-refresh-1");
        const secret = yield* secrets.get(`connector-${finished.id}`);
        expect(secret._tag === "Some" && new TextDecoder().decode(secret.value)).toContain(
          "oauth-refresh-1",
        );
      }),
    ),
  );

  it.effect("keeps the tokens a service rotates, and reports a revoked sign-in", () =>
    withConnectors(({ connectors, oauth, secrets }) =>
      Effect.gen(function* () {
        const started = yield* connectors.oauthSignInStart({
          name: "Linear",
          url: MCP_URL,
          httpBaseUrl: "https://t4.example.test",
        });
        oauth.approve(started.authUrl, "code-1");
        const connector = yield* connectors.signInFinish({
          state: started.state,
          code: "code-1",
          error: undefined,
        });

        oauth.expireAccessToken();
        expect((yield* connectors.refresh(connector.id)).health).toEqual({ _tag: "ok" });
        const secret = yield* secrets.get(`connector-${connector.id}`);
        const saved = secret._tag === "Some" ? new TextDecoder().decode(secret.value) : "";
        expect(saved).toContain("oauth-refresh-2");
        expect(saved).not.toContain("oauth-refresh-1");

        oauth.revoke();
        expect((yield* connectors.refresh(connector.id)).health).toEqual({
          _tag: "error",
          message: "Linear signed T4 out. Sign in again in Settings → Connectors.",
        });
      }),
    ),
  );

  it.effect("refuses a browser sign-in for a server that offers none", () =>
    withConnectors(({ connectors }) =>
      Effect.gen(function* () {
        const error = yield* connectors
          .oauthSignInStart({
            name: "Plain",
            url: "https://plain.example.test/mcp",
            httpBaseUrl: "https://t4.example.test",
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("sign_in_failed");
        expect(error.message).toContain("If it gives you an API key, use that.");
      }),
    ),
  );

  it.effect("fails the sign-in a user cancels on Google, and one that expires", () =>
    withConnectors(({ connectors }) =>
      Effect.gen(function* () {
        const cancelled = yield* connectors.googleSignInStart("https://t4.example.test");
        const waiting = yield* connectors.signInWait(cancelled.state).pipe(Effect.forkChild);
        yield* connectors
          .signInFinish({ state: cancelled.state, code: undefined, error: "access_denied" })
          .pipe(Effect.flip);
        const failure = yield* Fiber.join(waiting).pipe(Effect.flip);
        expect(failure.message).toBe("Google sign-in was cancelled.");

        const abandoned = yield* connectors.googleSignInStart("https://t4.example.test");
        const expiring = yield* connectors.signInWait(abandoned.state).pipe(Effect.forkChild);
        yield* TestClock.adjust("15 minutes");
        expect((yield* Fiber.join(expiring).pipe(Effect.flip)).reason).toBe("sign_in_expired");
        expect(yield* connectors.list).toEqual([]);
      }),
    ),
  );

  it.effect("calls Google with a fresh token after the old one is refused", () =>
    withConnectors(({ connectors, google }) =>
      Effect.gen(function* () {
        const started = yield* connectors.googleSignInStart("https://t4.example.test");
        google.approve(started.authUrl, "code-1");
        const connector = yield* connectors.signInFinish({
          state: started.state,
          code: "code-1",
          error: undefined,
        });
        google.rejectAccessToken("access-2");
        const result = yield* connectors.callTool(connector.id, "gmail_search", { query: "x" });
        expect(result).toEqual({ content: [{ type: "text", text: "[]" }], isError: false });
        const gmailCalls = google.requests.filter((request) =>
          request.url.includes("/gmail/v1/users/me/messages"),
        );
        expect(gmailCalls.map((request) => request.authorization)).toEqual([
          "Bearer access-2",
          "Bearer access-3",
        ]);
      }),
    ),
  );
});
