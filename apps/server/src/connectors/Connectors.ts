import {
  type Connector,
  type ConnectorAuth,
  ConnectorError,
  type ConnectorFailure,
  ConnectorId,
  type ConnectorOAuthSignInStartInput,
  type ConnectorSaveInput,
  type ConnectorSignIn,
  ConnectorSource,
  ConnectorTool,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  type ConnectorClient,
  type ConnectorTarget,
  httpStatus,
  type OpenConnectorClient,
  openHttpClient,
  type UpstreamCallResult,
  type UpstreamTool,
} from "./connectorClient.ts";
import {
  beginOAuthSignIn,
  completeOAuthSignIn,
  decodeOAuthCredentials,
  defaultOAuthFetch,
  encodeOAuthCredentials,
  oauthCallbackUrl,
  type OAuthCredentials,
  type OAuthFetch,
  oauthSession,
} from "./connectorOAuth.ts";
import {
  authorizationUrl,
  callbackUrl,
  defaultGoogleBroker,
  encodeState,
  exchangeCode,
  type GoogleBroker,
  pkceChallenge,
  refreshTokens,
} from "./google/googleOAuth.ts";
import { GOOGLE_TOOLS, googleAccountEmail, makeGoogleClient } from "./google/googleTools.ts";

const CONNECTORS_FILE = "connectors.json";
// Long enough to read a consent screen; the browser tab is useless after.
const SIGN_IN_TIMEOUT = Duration.minutes(15);

const ToolRecord = Schema.Struct({ ...ConnectorTool.fields, inputSchema: Schema.Unknown });

const ConnectorRecord = Schema.Struct({
  id: ConnectorId,
  name: Schema.String,
  source: ConnectorSource,
  createdAt: Schema.DateTimeUtc,
  tools: Schema.Array(ToolRecord),
  lastError: Schema.NullOr(Schema.String),
});
type ConnectorRecord = typeof ConnectorRecord.Type;

const ConnectorsFile = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({ version: Schema.Literal(1), connectors: Schema.Array(ConnectorRecord) }),
  ),
);
const decodeConnectorsFile = Schema.decodeUnknownEffect(ConnectorsFile);
const encodeConnectorsFile = Schema.encodeSync(ConnectorsFile);

const secretName = (id: ConnectorId) => `connector-${id}`;

const connectorError = (reason: ConnectorFailure, message: string) =>
  new ConnectorError({ reason, message });

/** Logs the cause, which may hold credentials, and fails with a fixed message. */
const storageFailure =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, ConnectorError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.andThen(Effect.fail(connectorError("storage", message))),
    );

/** How a connector proves who it is, which decides what a refusal tells the user to do. */
type SignInKind = "google" | "oauth" | "key";

const signInKind = (source: ConnectorSource): SignInKind =>
  source._tag === "google" ? "google" : source.auth._tag === "oauth" ? "oauth" : "key";

const REFUSED: Record<SignInKind, (name: string) => string> = {
  google: (name) => `${name} lost access to Google. Reconnect it in Settings → Connectors.`,
  oauth: (name) => `${name} signed T4 out. Sign in again in Settings → Connectors.`,
  key: (name) => `${name} refused T4's credentials. Check the header in Settings → Connectors.`,
};

const upstreamFailure = (name: string, cause: unknown, kind: SignInKind = "key") => {
  const status = httpStatus(cause);
  if (
    status === 401 ||
    status === 403 ||
    (cause instanceof Error && cause.name === "GoogleAuthError")
  ) {
    return connectorError("auth_failed", REFUSED[kind](name));
  }
  if (cause instanceof TypeError || status === 404 || (status !== undefined && status >= 500)) {
    return connectorError(
      "unreachable",
      kind === "google" ? "Could not reach Google." : `Could not reach ${name}'s MCP server.`,
    );
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return connectorError("provider_error", `${name} returned an error: ${detail}`);
};

const toConnector = (record: ConnectorRecord): Connector => ({
  id: record.id,
  name: record.name,
  source: record.source,
  createdAt: record.createdAt,
  tools: record.tools.map(({ name, description, readOnly }) => ({ name, description, readOnly })),
  health: record.lastError === null ? { _tag: "ok" } : { _tag: "error", message: record.lastError },
});

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "connector";

export class Connectors extends Context.Service<
  Connectors,
  {
    readonly list: Effect.Effect<ReadonlyArray<Connector>, ConnectorError>;
    /** Connects and lists tools before saving, so a saved connector works. */
    readonly save: (input: ConnectorSaveInput) => Effect.Effect<Connector, ConnectorError>;
    readonly remove: (id: ConnectorId) => Effect.Effect<boolean, ConnectorError>;
    /** Reconnects and relists tools. A server that fails is recorded on the connector. */
    readonly refresh: (id: ConnectorId) => Effect.Effect<Connector, ConnectorError>;
    readonly describeTool: (
      id: ConnectorId,
      tool: string,
    ) => Effect.Effect<typeof ToolRecord.Type, ConnectorError>;
    readonly callTool: (
      id: ConnectorId,
      tool: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<UpstreamCallResult, ConnectorError>;
    readonly googleSignInStart: (
      httpBaseUrl: string,
    ) => Effect.Effect<ConnectorSignIn, ConnectorError>;
    /** Finds the MCP server's own sign-in page. The connector is saved once the browser returns. */
    readonly oauthSignInStart: (
      input: ConnectorOAuthSignInStartInput,
    ) => Effect.Effect<ConnectorSignIn, ConnectorError>;
    /** Resolves when the browser finishes signing in, or fails when it gives up or expires. */
    readonly signInWait: (state: string) => Effect.Effect<Connector, ConnectorError>;
    /** What the server's callback routes run with the service's reply. */
    readonly signInFinish: (input: {
      readonly state: string;
      readonly code: string | undefined;
      readonly error: string | undefined;
    }) => Effect.Effect<Connector, ConnectorError>;
  }
>()("t3/connectors/Connectors") {}

interface PendingSignIn {
  /** Named in what the user reads: Google, or the connector being added. */
  readonly service: string;
  /** Trades the code the browser came back with for a saved connector. */
  readonly complete: (code: string) => Effect.Effect<Connector, ConnectorError>;
  readonly deferred: Deferred.Deferred<Connector, ConnectorError>;
  /** The service's reply came back; the code is spent. */
  readonly claimed: boolean;
}

export interface ConnectorsOptions {
  readonly open: OpenConnectorClient;
  readonly google: GoogleBroker;
  /** Reaches a service's sign-in endpoints. */
  readonly oauthFetch: OAuthFetch;
}

const make = Effect.fn("Connectors.make")(function* (options: ConnectorsOptions) {
  const { open, google, oauthFetch } = options;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const connectorsPath = path.join(config.stateDir, CONNECTORS_FILE);
  const recordsLock = yield* Semaphore.make(1);
  const clients = yield* Ref.make<ReadonlyMap<ConnectorId, ConnectorClient>>(new Map());
  const pendingSignIns = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());
  const scope = yield* Effect.scope;
  // The MCP SDK saves refreshed tokens from a promise callback.
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const randomHex = (bytes: number) =>
    crypto.randomBytes(bytes).pipe(Effect.orDie, Effect.map(Hex.encode));

  const readRecords = Effect.fn("Connectors.readRecords")(function* () {
    const text = yield* fileSystem.readFileString(connectorsPath).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      Effect.catch(storageFailure("Could not read the connectors.")),
    );
    if (Option.isNone(text)) return [] as ReadonlyArray<ConnectorRecord>;
    const file = yield* decodeConnectorsFile(text.value).pipe(
      Effect.catch(storageFailure("The connectors file is unreadable.")),
    );
    return file.connectors;
  });

  const writeRecords = Effect.fn("Connectors.writeRecords")(function* (
    connectors: ReadonlyArray<ConnectorRecord>,
  ) {
    const tempPath = `${connectorsPath}.${yield* randomHex(8)}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.writeFileString(
        tempPath,
        encodeConnectorsFile({ version: 1, connectors }),
        {
          mode: 0o600,
        },
      );
      yield* fileSystem.rename(tempPath, connectorsPath);
    }).pipe(
      Effect.catch((cause) =>
        fileSystem
          .remove(tempPath)
          .pipe(
            Effect.ignore,
            Effect.andThen(storageFailure("Could not save the connectors.")(cause)),
          ),
      ),
    );
  });

  const updateRecords = <A>(
    update: (connectors: ReadonlyArray<ConnectorRecord>) => {
      readonly connectors: ReadonlyArray<ConnectorRecord>;
      readonly result: A;
    },
  ) =>
    recordsLock.withPermits(1)(
      Effect.gen(function* () {
        const next = update(yield* readRecords());
        yield* writeRecords(next.connectors);
        return next.result;
      }),
    );

  const patchRecord = (id: ConnectorId, patch: Partial<ConnectorRecord>) =>
    updateRecords((connectors) => ({
      connectors: connectors.map((record) => (record.id === id ? { ...record, ...patch } : record)),
      result: undefined,
    }));

  const putRecord = (record: ConnectorRecord) =>
    updateRecords((connectors) => ({
      connectors: connectors.some((candidate) => candidate.id === record.id)
        ? connectors.map((candidate) => (candidate.id === record.id ? record : candidate))
        : [...connectors, record],
      result: undefined,
    }));

  const findRecord = Effect.fn("Connectors.findRecord")(function* (id: ConnectorId) {
    const record = (yield* readRecords()).find((candidate) => candidate.id === id);
    if (record === undefined) {
      return yield* connectorError("unknown_connector", `No connector is named ${id}.`);
    }
    return record;
  });

  const readSecret = Effect.fn("Connectors.readSecret")(function* (id: ConnectorId) {
    const bytes = yield* secrets
      .get(secretName(id))
      .pipe(Effect.catch(storageFailure("Could not read the connector's credentials.")));
    return Option.map(bytes, (value) => new TextDecoder().decode(value));
  });

  const requiredSecret = Effect.fn("Connectors.requiredSecret")(function* (
    record: ConnectorRecord,
  ) {
    const value = yield* readSecret(record.id);
    if (Option.isNone(value)) {
      return yield* connectorError(
        "auth_failed",
        `${record.name}'s saved credentials are missing. Reconnect it in Settings → Connectors.`,
      );
    }
    return value.value;
  });

  const saveOAuthCredentials = (id: ConnectorId, credentials: OAuthCredentials) =>
    secrets
      .set(secretName(id), new TextEncoder().encode(encodeOAuthCredentials(credentials)))
      .pipe(Effect.catch(storageFailure("Could not save the connector's sign-in.")));

  /** Signs a saved connector's requests, keeping the tokens the service rotates. */
  const savedOAuthProvider = (id: ConnectorId, credentials: OAuthCredentials) =>
    oauthSession({
      credentials,
      // Unsaved tokens still work until a restart, so a failed write must not fail the call.
      onTokens: (next) => runPromise(saveOAuthCredentials(id, next).pipe(Effect.ignore)),
    }).provider;

  const connect = (name: string, target: ConnectorTarget) =>
    Effect.tryPromise({
      try: async () => {
        const client = await open(target);
        try {
          return { client, tools: await client.listTools() };
        } catch (error) {
          await client.close().catch(() => undefined);
          throw error;
        }
      },
      catch: (cause) =>
        upstreamFailure(name, cause, target.authProvider === undefined ? "key" : "oauth"),
    });

  /** A client for a saved connector. Google's tools are built in, so opening it is free. */
  const openRecord = Effect.fn("Connectors.openRecord")(function* (record: ConnectorRecord) {
    const source = record.source;
    if (source._tag === "google") {
      const client = makeGoogleClient({
        refreshToken: yield* requiredSecret(record),
        broker: google,
      });
      return { client, tools: GOOGLE_TOOLS };
    }
    if (source.auth._tag === "oauth") {
      const credentials = decodeOAuthCredentials(yield* requiredSecret(record));
      if (credentials === undefined) {
        return yield* connectorError("auth_failed", REFUSED.oauth(record.name));
      }
      return yield* connect(record.name, {
        url: source.url,
        headers: {},
        authProvider: savedOAuthProvider(record.id, credentials),
      });
    }
    const headers =
      source.auth._tag === "header" ? { [source.auth.name]: yield* requiredSecret(record) } : {};
    return yield* connect(record.name, { url: source.url, headers });
  });

  const closeClient = (client: ConnectorClient) =>
    Effect.promise(() => client.close().catch(() => undefined));

  /** Swaps in a live client, closing the one it replaces. */
  const pool = (id: ConnectorId, client: ConnectorClient | undefined) =>
    Ref.modify(clients, (current) => {
      const next = new Map(current);
      const previous = next.get(id);
      if (client === undefined) next.delete(id);
      else next.set(id, client);
      return [previous, next] as const;
    }).pipe(
      Effect.flatMap((previous) =>
        previous === undefined || previous === client ? Effect.void : closeClient(previous),
      ),
    );

  const connectLock = yield* Semaphore.make(1);
  const clientFor = (record: ConnectorRecord) =>
    connectLock.withPermits(1)(
      Effect.gen(function* () {
        const pooled = (yield* Ref.get(clients)).get(record.id);
        if (pooled !== undefined) return pooled;
        const { client } = yield* openRecord(record);
        yield* pool(record.id, client);
        return client;
      }),
    );

  /** Records an auth refusal or an unreachable server as the connector's health. */
  const tracked = <A>(record: ConnectorRecord, effect: Effect.Effect<A, ConnectorError>) =>
    effect.pipe(
      Effect.tap(() =>
        record.lastError === null
          ? Effect.void
          : patchRecord(record.id, { lastError: null }).pipe(Effect.ignore),
      ),
      Effect.tapError((error) =>
        error.reason === "auth_failed" || error.reason === "unreachable"
          ? patchRecord(record.id, { lastError: error.message }).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

  yield* Effect.addFinalizer(() =>
    Ref.get(clients).pipe(
      Effect.flatMap((current) => Effect.forEach(current.values(), closeClient, { discard: true })),
    ),
  );

  const list = readRecords().pipe(Effect.map((records) => records.map(toConnector)));

  const save = Effect.fn("Connectors.save")(function* (input: ConnectorSaveInput) {
    const existing =
      input.connectorId === undefined ? undefined : yield* findRecord(input.connectorId);
    const id = existing?.id ?? ConnectorId.make(`${slug(input.name)}-${yield* randomHex(2)}`);
    let headerValue: string | undefined;
    if (input.auth._tag === "header") {
      headerValue =
        input.auth.value === undefined
          ? Option.getOrUndefined(
              // A browser sign-in's saved tokens are not a header value.
              existing?.source._tag === "mcp" && existing.source.auth._tag === "header"
                ? yield* readSecret(existing.id)
                : Option.none(),
            )
          : Redacted.value(input.auth.value);
      if (headerValue === undefined) {
        return yield* connectorError("auth_failed", "Enter the header's value.");
      }
    }
    const auth: ConnectorAuth =
      input.auth._tag === "header" ? { _tag: "header", name: input.auth.name } : { _tag: "none" };
    const { client, tools } = yield* connect(input.name, {
      url: input.url,
      headers:
        input.auth._tag === "header" && headerValue !== undefined
          ? { [input.auth.name]: headerValue }
          : {},
    });
    const record: ConnectorRecord = {
      id,
      name: input.name,
      source: { _tag: "mcp", url: input.url, auth },
      createdAt: existing?.createdAt ?? (yield* DateTime.now),
      tools: toolRecords(tools),
      lastError: null,
    };
    yield* Effect.gen(function* () {
      if (headerValue === undefined) {
        yield* secrets.remove(secretName(id)).pipe(Effect.ignore);
      } else {
        yield* secrets
          .set(secretName(id), new TextEncoder().encode(headerValue))
          .pipe(Effect.catch(storageFailure("Could not save the connector's credentials.")));
      }
      yield* putRecord(record);
    }).pipe(Effect.onError(() => closeClient(client)));
    yield* pool(id, client);
    return toConnector(record);
  });

  const remove = Effect.fn("Connectors.remove")(function* (id: ConnectorId) {
    const removed = yield* updateRecords((connectors) => ({
      connectors: connectors.filter((record) => record.id !== id),
      result: connectors.some((record) => record.id === id),
    }));
    yield* pool(id, undefined);
    yield* secrets.remove(secretName(id)).pipe(Effect.ignore);
    return removed;
  });

  const refresh = Effect.fn("Connectors.refresh")(function* (id: ConnectorId) {
    const record = yield* findRecord(id);
    const connected = yield* openRecord(record).pipe(
      // Opening Google checks nothing, so refresh proves the account still grants access.
      Effect.tap(() =>
        record.source._tag === "google"
          ? requiredSecret(record).pipe(
              Effect.flatMap((refreshToken) =>
                Effect.tryPromise({
                  try: () => refreshTokens(google, refreshToken),
                  catch: (cause) => upstreamFailure(record.name, cause, "google"),
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.result,
    );
    if (connected._tag === "Failure") {
      const failed = { ...record, lastError: connected.failure.message };
      yield* patchRecord(id, { lastError: failed.lastError });
      return toConnector(failed);
    }
    const refreshed = { ...record, tools: toolRecords(connected.success.tools), lastError: null };
    yield* patchRecord(id, { tools: refreshed.tools, lastError: null });
    yield* pool(id, connected.success.client);
    return toConnector(refreshed);
  });

  const describeTool = Effect.fn("Connectors.describeTool")(function* (
    id: ConnectorId,
    name: string,
  ) {
    const record = yield* findRecord(id);
    const tool = record.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return yield* connectorError(
        "unknown_tool",
        `${record.name} has no tool named ${name}. Search connectors for its tools.`,
      );
    }
    return tool;
  });

  const callTool = Effect.fn("Connectors.callTool")(function* (
    id: ConnectorId,
    name: string,
    args: Record<string, unknown>,
  ) {
    const record = yield* findRecord(id);
    yield* describeTool(id, name);
    return yield* tracked(
      record,
      clientFor(record).pipe(
        Effect.flatMap((client) =>
          Effect.tryPromise({
            try: () => client.callTool(name, args),
            catch: (cause) => upstreamFailure(record.name, cause, signInKind(record.source)),
          }).pipe(
            // A failed session is not reused; the next call opens a fresh one. Never retried here: it may have written.
            Effect.tapError(() =>
              Ref.get(clients).pipe(
                Effect.flatMap((current) =>
                  current.get(id) === client ? pool(id, undefined) : Effect.void,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });

  const dropPending = (state: string) =>
    Ref.modify(pendingSignIns, (current) => {
      const pending = current.get(state);
      if (pending === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(state);
      return [pending, next] as const;
    });

  // A finished sign-in stays until it expires, so a wait that arrives late still sees its result.
  const claimPending = (state: string) =>
    Ref.modify(pendingSignIns, (current) => {
      const pending = current.get(state);
      if (pending === undefined || pending.claimed) return [undefined, current] as const;
      return [pending, new Map(current).set(state, { ...pending, claimed: true })] as const;
    });

  /** Holds a sign-in open under its unguessable state until the browser returns or it expires. */
  const awaitBrowser = Effect.fn("Connectors.awaitBrowser")(function* (
    state: string,
    service: string,
    complete: PendingSignIn["complete"],
  ) {
    const deferred = yield* Deferred.make<Connector, ConnectorError>();
    yield* Ref.update(pendingSignIns, (current) =>
      new Map(current).set(state, { service, complete, deferred, claimed: false }),
    );
    yield* Effect.sleep(SIGN_IN_TIMEOUT).pipe(
      Effect.andThen(dropPending(state)),
      Effect.flatMap((pending) =>
        pending === undefined
          ? Effect.void
          : Deferred.fail(
              pending.deferred,
              connectorError("sign_in_expired", `The ${service} sign-in expired. Start again.`),
            ),
      ),
      Effect.forkIn(scope),
    );
  });

  const signInFailed = (service: string) => (cause: unknown) =>
    connectorError(
      "sign_in_failed",
      `${service} sign-in failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );

  const completeGoogle = Effect.fn("Connectors.completeGoogle")(function* (
    codeVerifier: string,
    code: string,
  ) {
    const failed = signInFailed("Google");
    const tokens = yield* Effect.tryPromise({
      try: () => exchangeCode(google, { code, codeVerifier }),
      catch: failed,
    });
    const refreshToken = tokens.refreshToken;
    if (refreshToken === undefined) {
      return yield* connectorError(
        "sign_in_failed",
        "Google did not grant lasting access. Connect Google again.",
      );
    }
    const email = yield* Effect.tryPromise({
      try: () => googleAccountEmail(google, tokens.accessToken),
      catch: failed,
    });
    const existing = (yield* readRecords()).find(
      (record) => record.source._tag === "google" && record.source.email === email,
    );
    const id = existing?.id ?? ConnectorId.make(`google-${yield* randomHex(2)}`);
    const record: ConnectorRecord = {
      id,
      name: `Google (${email})`,
      source: { _tag: "google", email },
      createdAt: existing?.createdAt ?? (yield* DateTime.now),
      tools: toolRecords(GOOGLE_TOOLS),
      lastError: null,
    };
    yield* secrets
      .set(secretName(id), new TextEncoder().encode(refreshToken))
      .pipe(Effect.catch(storageFailure("Could not save the Google account's credentials.")));
    yield* putRecord(record);
    yield* pool(id, makeGoogleClient({ refreshToken, broker: google }));
    return toConnector(record);
  });

  const googleSignInStart = Effect.fn("Connectors.googleSignInStart")(function* (
    httpBaseUrl: string,
  ) {
    const nonce = yield* randomHex(16);
    const codeVerifier = yield* randomHex(32);
    const state = encodeState({ returnUrl: callbackUrl(httpBaseUrl), nonce });
    const codeChallenge = yield* Effect.promise(() => pkceChallenge(codeVerifier));
    yield* awaitBrowser(state, "Google", (code) => completeGoogle(codeVerifier, code));
    return { authUrl: authorizationUrl({ brokerUrl: google.url, state, codeChallenge }), state };
  });

  const oauthSignInStart = Effect.fn("Connectors.oauthSignInStart")(function* (
    input: ConnectorOAuthSignInStartInput,
  ) {
    const existing =
      input.connectorId === undefined ? undefined : yield* findRecord(input.connectorId);
    const state = yield* randomHex(16);
    const signIn = oauthSession({
      credentials: {
        redirectUrl: oauthCallbackUrl(input.httpBaseUrl),
        client: undefined,
        tokens: undefined,
      },
      state,
    });
    const authUrl = yield* Effect.tryPromise({
      try: () => beginOAuthSignIn(signIn, input.url, oauthFetch),
      catch: (cause) => ({ cause, unreachable: cause instanceof TypeError }),
    }).pipe(
      Effect.catch(({ cause, unreachable }) =>
        unreachable
          ? Effect.fail(
              connectorError("unreachable", `Could not reach ${input.name}'s MCP server.`),
            )
          : // The cause is often the service's whole error page, so it goes to the log.
            Effect.logWarning("Connector offers no usable browser sign-in", {
              url: input.url,
              cause,
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  connectorError(
                    "sign_in_failed",
                    `${input.name} has no browser sign-in T4 can use. If it gives you an API key, use that.`,
                  ),
                ),
              ),
            ),
      ),
    );
    const complete = Effect.fn("Connectors.completeOAuth")(function* (code: string) {
      yield* Effect.tryPromise({
        try: () => completeOAuthSignIn(signIn, input.url, code, oauthFetch),
        catch: signInFailed(input.name),
      });
      const id = existing?.id ?? ConnectorId.make(`${slug(input.name)}-${yield* randomHex(2)}`);
      const credentials = signIn.credentials();
      const { client, tools } = yield* connect(input.name, {
        url: input.url,
        headers: {},
        authProvider: savedOAuthProvider(id, credentials),
      });
      const record: ConnectorRecord = {
        id,
        name: input.name,
        source: { _tag: "mcp", url: input.url, auth: { _tag: "oauth" } },
        createdAt: existing?.createdAt ?? (yield* DateTime.now),
        tools: toolRecords(tools),
        lastError: null,
      };
      yield* saveOAuthCredentials(id, credentials).pipe(
        Effect.andThen(putRecord(record)),
        Effect.onError(() => closeClient(client)),
      );
      yield* pool(id, client);
      return toConnector(record);
    });
    yield* awaitBrowser(state, input.name, complete);
    return { authUrl: authUrl.href, state };
  });

  const signInWait = Effect.fn("Connectors.signInWait")(function* (state: string) {
    const pending = (yield* Ref.get(pendingSignIns)).get(state);
    if (pending === undefined) {
      return yield* connectorError("sign_in_expired", "No sign-in is in progress. Start again.");
    }
    return yield* Deferred.await(pending.deferred);
  });

  const signInFinish = Effect.fn("Connectors.signInFinish")(function* (input: {
    readonly state: string;
    readonly code: string | undefined;
    readonly error: string | undefined;
  }) {
    const pending = yield* claimPending(input.state);
    if (pending === undefined) {
      return yield* connectorError(
        "sign_in_expired",
        "This sign-in already finished or expired. Start again from T4.",
      );
    }
    const result =
      input.code === undefined
        ? Effect.fail(
            connectorError(
              "sign_in_failed",
              input.error === "access_denied"
                ? `${pending.service} sign-in was cancelled.`
                : `${pending.service} sign-in failed: ${input.error ?? "no code came back"}.`,
            ),
          )
        : pending.complete(input.code);
    const exit = yield* Effect.exit(result);
    yield* Deferred.done(pending.deferred, exit);
    return yield* exit;
  });

  return Connectors.of({
    list,
    save,
    remove,
    refresh,
    describeTool,
    callTool,
    googleSignInStart,
    oauthSignInStart,
    signInWait,
    signInFinish,
  });
});

const toolRecords = (tools: ReadonlyArray<UpstreamTool>) =>
  tools.map(({ name, description, readOnly, inputSchema }) => ({
    name,
    description,
    readOnly,
    inputSchema,
  }));

export const layerWith = (options: ConnectorsOptions) => Layer.effect(Connectors, make(options));

export const layer = layerWith({
  open: openHttpClient,
  google: defaultGoogleBroker(),
  oauthFetch: defaultOAuthFetch,
});
