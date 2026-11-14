import {
  type Connector,
  type ConnectorAuth,
  ConnectorError,
  type ConnectorFailure,
  type ConnectorGoogleSignIn,
  ConnectorId,
  type ConnectorSaveInput,
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
// Long enough to read Google's consent screen; the browser tab is useless after.
const GOOGLE_SIGN_IN_TIMEOUT = Duration.minutes(15);

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

const upstreamFailure = (name: string, cause: unknown, kind: ConnectorSource["_tag"] = "mcp") => {
  const status = httpStatus(cause);
  if (
    status === 401 ||
    status === 403 ||
    (cause instanceof Error && cause.name === "GoogleAuthError")
  ) {
    return connectorError(
      "auth_failed",
      kind === "google"
        ? `${name} lost access to Google. Reconnect it in Settings → Connectors.`
        : `${name} refused T4's credentials. Check the header in Settings → Connectors.`,
    );
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
    ) => Effect.Effect<ConnectorGoogleSignIn, ConnectorError>;
    /** Resolves when the browser finishes on Google, or fails when it gives up or expires. */
    readonly googleSignInWait: (state: string) => Effect.Effect<Connector, ConnectorError>;
    /** What the server's callback route runs with Google's reply. */
    readonly googleSignInFinish: (input: {
      readonly state: string;
      readonly code: string | undefined;
      readonly error: string | undefined;
    }) => Effect.Effect<Connector, ConnectorError>;
  }
>()("t3/connectors/Connectors") {}

interface PendingGoogleSignIn {
  readonly codeVerifier: string;
  readonly deferred: Deferred.Deferred<Connector, ConnectorError>;
  /** Google's reply came back; the code is spent. */
  readonly claimed: boolean;
}

export interface ConnectorsOptions {
  readonly open: OpenConnectorClient;
  readonly google: GoogleBroker;
}

const make = Effect.fn("Connectors.make")(function* (options: ConnectorsOptions) {
  const { open, google } = options;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const connectorsPath = path.join(config.stateDir, CONNECTORS_FILE);
  const recordsLock = yield* Semaphore.make(1);
  const clients = yield* Ref.make<ReadonlyMap<ConnectorId, ConnectorClient>>(new Map());
  const pendingGoogle = yield* Ref.make<ReadonlyMap<string, PendingGoogleSignIn>>(new Map());
  const scope = yield* Effect.scope;

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
      catch: (cause) => upstreamFailure(name, cause),
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
              existing === undefined ? Option.none() : yield* readSecret(existing.id),
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
      yield* updateRecords((connectors) => ({
        connectors:
          existing === undefined
            ? [...connectors, record]
            : connectors.map((candidate) => (candidate.id === id ? record : candidate)),
        result: undefined,
      }));
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
            catch: (cause) => upstreamFailure(record.name, cause, record.source._tag),
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
    Ref.modify(pendingGoogle, (current) => {
      const pending = current.get(state);
      if (pending === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(state);
      return [pending, next] as const;
    });

  // A finished sign-in stays until it expires, so a wait that arrives late still sees its result.
  const claimPending = (state: string) =>
    Ref.modify(pendingGoogle, (current) => {
      const pending = current.get(state);
      if (pending === undefined || pending.claimed) return [undefined, current] as const;
      return [pending, new Map(current).set(state, { ...pending, claimed: true })] as const;
    });

  const googleSignInStart = Effect.fn("Connectors.googleSignInStart")(function* (
    httpBaseUrl: string,
  ) {
    const nonce = yield* randomHex(16);
    const codeVerifier = yield* randomHex(32);
    const state = encodeState({ returnUrl: callbackUrl(httpBaseUrl), nonce });
    const codeChallenge = yield* Effect.promise(() => pkceChallenge(codeVerifier));
    const deferred = yield* Deferred.make<Connector, ConnectorError>();
    yield* Ref.update(pendingGoogle, (current) =>
      new Map(current).set(state, { codeVerifier, deferred, claimed: false }),
    );
    yield* Effect.sleep(GOOGLE_SIGN_IN_TIMEOUT).pipe(
      Effect.andThen(dropPending(state)),
      Effect.flatMap((pending) =>
        pending === undefined
          ? Effect.void
          : Deferred.fail(
              pending.deferred,
              connectorError("sign_in_expired", "The Google sign-in expired. Start again."),
            ),
      ),
      Effect.forkIn(scope),
    );
    return { authUrl: authorizationUrl({ brokerUrl: google.url, state, codeChallenge }), state };
  });

  const googleSignInWait = Effect.fn("Connectors.googleSignInWait")(function* (state: string) {
    const pending = (yield* Ref.get(pendingGoogle)).get(state);
    if (pending === undefined) {
      return yield* connectorError(
        "sign_in_expired",
        "No Google sign-in is in progress. Start again.",
      );
    }
    return yield* Deferred.await(pending.deferred);
  });

  const completeGoogle = Effect.fn("Connectors.completeGoogle")(function* (
    pending: PendingGoogleSignIn,
    code: string,
  ) {
    const failed = (cause: unknown) =>
      connectorError(
        "sign_in_failed",
        `Google sign-in failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    const tokens = yield* Effect.tryPromise({
      try: () => exchangeCode(google, { code, codeVerifier: pending.codeVerifier }),
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
    yield* updateRecords((connectors) => ({
      connectors:
        existing === undefined
          ? [...connectors, record]
          : connectors.map((candidate) => (candidate.id === id ? record : candidate)),
      result: undefined,
    }));
    yield* pool(id, makeGoogleClient({ refreshToken, broker: google }));
    return toConnector(record);
  });

  const googleSignInFinish = Effect.fn("Connectors.googleSignInFinish")(function* (input: {
    readonly state: string;
    readonly code: string | undefined;
    readonly error: string | undefined;
  }) {
    const pending = yield* claimPending(input.state);
    if (pending === undefined) {
      return yield* connectorError(
        "sign_in_expired",
        "This Google sign-in already finished or expired. Start again from T4.",
      );
    }
    const result =
      input.code === undefined
        ? Effect.fail(
            connectorError(
              "sign_in_failed",
              input.error === "access_denied"
                ? "Google sign-in was cancelled."
                : `Google sign-in failed: ${input.error ?? "no code came back"}.`,
            ),
          )
        : completeGoogle(pending, input.code);
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
    googleSignInWait,
    googleSignInFinish,
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
});
