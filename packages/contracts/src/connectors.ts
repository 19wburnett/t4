import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Services connected once on this environment, which every agent here reaches
 * through T4's own MCP server: any MCP server by URL, or a Google account.
 * Credentials stay on the server.
 */
export const ConnectorId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
).pipe(Schema.brand("ConnectorId"));
export type ConnectorId = typeof ConnectorId.Type;

export const ConnectorUrl = TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/\S+$/i));

/** How T4 signs requests to the server, without the secret. */
export const ConnectorAuth = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("header", { name: TrimmedNonEmptyString }),
]);
export type ConnectorAuth = typeof ConnectorAuth.Type;

export const ConnectorTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** From the server's `readOnlyHint`; a tool that does not say counts as a write. */
  readOnly: Schema.Boolean,
});
export type ConnectorTool = typeof ConnectorTool.Type;

export const ConnectorHealth = Schema.Union([
  Schema.TaggedStruct("ok", {}),
  Schema.TaggedStruct("error", { message: Schema.String }),
]);
export type ConnectorHealth = typeof ConnectorHealth.Type;

/** What a connector talks to. Google tools are built into T4, not an MCP server. */
export const ConnectorSource = Schema.Union([
  Schema.TaggedStruct("mcp", { url: ConnectorUrl, auth: ConnectorAuth }),
  Schema.TaggedStruct("google", { email: Schema.String }),
]);
export type ConnectorSource = typeof ConnectorSource.Type;

export const Connector = Schema.Struct({
  id: ConnectorId,
  name: TrimmedNonEmptyString,
  source: ConnectorSource,
  createdAt: Schema.DateTimeUtc,
  /** As of the last connect or refresh. */
  tools: Schema.Array(ConnectorTool),
  health: ConnectorHealth,
});
export type Connector = typeof Connector.Type;

/** Saving with an omitted header value keeps the saved one. */
export const ConnectorAuthInput = Schema.Union([
  Schema.TaggedStruct("none", {}),
  Schema.TaggedStruct("header", {
    name: TrimmedNonEmptyString,
    value: Schema.optionalKey(Schema.RedactedFromValue(TrimmedNonEmptyString)),
  }),
]);
export type ConnectorAuthInput = typeof ConnectorAuthInput.Type;

export const ConnectorSaveInput = Schema.Struct({
  /** Omitted to add a connector. */
  connectorId: Schema.optionalKey(ConnectorId),
  name: TrimmedNonEmptyString,
  url: ConnectorUrl,
  auth: ConnectorAuthInput,
});
export type ConnectorSaveInput = typeof ConnectorSaveInput.Type;

export const ConnectorInput = Schema.Struct({ connectorId: ConnectorId });
export type ConnectorInput = typeof ConnectorInput.Type;

export const ConnectorList = Schema.Struct({ connectors: Schema.Array(Connector) });
export type ConnectorList = typeof ConnectorList.Type;

export const ConnectorRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type ConnectorRemoveResult = typeof ConnectorRemoveResult.Type;

export const ConnectorGoogleSignInStartInput = Schema.Struct({
  /**
   * This environment's HTTP base URL as the browser reaches it. Google's reply
   * comes back through it, so remote and tunneled clients work.
   */
  httpBaseUrl: ConnectorUrl,
});
export type ConnectorGoogleSignInStartInput = typeof ConnectorGoogleSignInStartInput.Type;

export const ConnectorGoogleSignIn = Schema.Struct({
  /** Opens Google's consent screen. */
  authUrl: Schema.String,
  /** Identifies this sign-in to wait on it. */
  state: Schema.String,
});
export type ConnectorGoogleSignIn = typeof ConnectorGoogleSignIn.Type;

export const ConnectorGoogleSignInWaitInput = Schema.Struct({ state: Schema.String });
export type ConnectorGoogleSignInWaitInput = typeof ConnectorGoogleSignInWaitInput.Type;

const CONNECTOR_FAILURES = [
  "unknown_connector",
  "unknown_tool",
  "auth_failed",
  "unreachable",
  "provider_error",
  "storage",
  "sign_in_expired",
  "sign_in_failed",
] as const;
export const ConnectorFailure = Schema.Literals(CONNECTOR_FAILURES);
export type ConnectorFailure = typeof ConnectorFailure.Type;

/** Why a connector call failed, in words a user can act on. The server logs causes. */
export class ConnectorError extends Schema.TaggedError<ConnectorError>()("ConnectorError", {
  reason: ConnectorFailure,
  message: Schema.String,
}) {}
