import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
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

/** An in-memory MCP server that wants `TOKEN` and records what it is asked. */
const upstream = () => {
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
    if (target.headers["Authorization"] !== TOKEN) {
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
    readonly stateDir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fake = upstream();
    const google = fakeGoogle();
    const layer = Connectors.layerWith({ open: fake.open, google: google.broker }).pipe(
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
      return yield* use({ connectors, secrets, fake, google, stateDir });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const linear: ConnectorSaveInput = {
  name: "Linear",
  url: "https://mcp.example.test/mcp",
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
        const waiting = yield* connectors.googleSignInWait(started.state).pipe(Effect.forkChild);
        const finished = yield* connectors.googleSignInFinish({
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
          .googleSignInFinish({ state: started.state, code: "code-1", error: undefined })
          .pipe(Effect.flip);
        expect(replay.reason).toBe("sign_in_expired");
      }),
    ),
  );

  it.effect("fails the sign-in a user cancels on Google, and one that expires", () =>
    withConnectors(({ connectors }) =>
      Effect.gen(function* () {
        const cancelled = yield* connectors.googleSignInStart("https://t4.example.test");
        const waiting = yield* connectors.googleSignInWait(cancelled.state).pipe(Effect.forkChild);
        yield* connectors
          .googleSignInFinish({ state: cancelled.state, code: undefined, error: "access_denied" })
          .pipe(Effect.flip);
        const failure = yield* Fiber.join(waiting).pipe(Effect.flip);
        expect(failure.message).toBe("Google sign-in was cancelled.");

        const abandoned = yield* connectors.googleSignInStart("https://t4.example.test");
        const expiring = yield* connectors.googleSignInWait(abandoned.state).pipe(Effect.forkChild);
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
        const connector = yield* connectors.googleSignInFinish({
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
