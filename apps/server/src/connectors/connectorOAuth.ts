// The MCP SDK runs the OAuth handshake: discovery, client registration, PKCE, and token refresh.
// This file gives it somewhere to keep what it learns.
// @effect-diagnostics globalFetch:off
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";

export const oauthCallbackUrl = (httpBaseUrl: string) =>
  new URL(OAUTH_CALLBACK_PATH, httpBaseUrl).href;

/** What a browser sign-in leaves behind. All of it is the connector's secret. */
export interface OAuthCredentials {
  /** The service ties the client to this address, so later token requests name it too. */
  readonly redirectUrl: string;
  readonly client: OAuthClientInformationMixed | undefined;
  readonly tokens: OAuthTokens | undefined;
}

export const encodeOAuthCredentials = (credentials: OAuthCredentials) =>
  JSON.stringify(credentials);

export const decodeOAuthCredentials = (text: string): OAuthCredentials | undefined => {
  try {
    const json = JSON.parse(text) as Partial<OAuthCredentials>;
    // Checked, not parsed: the SDK also reads registration fields its schema would strip.
    return typeof json.redirectUrl === "string" &&
      OAuthClientInformationSchema.safeParse(json.client).success &&
      OAuthTokensSchema.safeParse(json.tokens).success
      ? { redirectUrl: json.redirectUrl, client: json.client, tokens: json.tokens }
      : undefined;
  } catch {
    return undefined;
  }
};

export interface OAuthSession {
  readonly provider: OAuthClientProvider;
  readonly credentials: () => OAuthCredentials;
  /** The consent page the SDK wants opened, once it asks. */
  readonly authorizationUrl: () => URL | undefined;
}

/**
 * The SDK's view of one connector's sign-in. `state` marks a sign-in a person is finishing in a
 * browser; without it nobody is there, so a service that wants consent again fails as signed out.
 */
export const oauthSession = (input: {
  readonly credentials: OAuthCredentials;
  readonly state?: string;
  /** Tokens rotate on refresh; the caller saves them so a restart does not sign the connector out. */
  readonly onTokens?: (credentials: OAuthCredentials) => Promise<void>;
}): OAuthSession => {
  let credentials = input.credentials;
  let codeVerifier = "";
  let discovery: OAuthDiscoveryState | undefined;
  let authorizationUrl: URL | undefined;
  const { state } = input;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return credentials.redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: "T4",
        redirect_uris: [credentials.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // T4 runs on the user's machine and cannot keep a client secret from them.
        token_endpoint_auth_method: "none",
      };
    },
    ...(state === undefined ? {} : { state: () => state }),
    clientInformation: () => credentials.client,
    saveClientInformation: (client) => {
      credentials = { ...credentials, client };
    },
    tokens: () => credentials.tokens,
    saveTokens: async (tokens) => {
      credentials = { ...credentials, tokens };
      await input.onTokens?.(credentials);
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    saveCodeVerifier: (verifier) => {
      codeVerifier = verifier;
    },
    codeVerifier: () => codeVerifier,
    // The SDK drops what a service rejected and retries, which ends at the consent page.
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "tokens")
        credentials = { ...credentials, tokens: undefined };
      if (scope === "all" || scope === "client")
        credentials = { ...credentials, client: undefined };
      if (scope === "all" || scope === "discovery") discovery = undefined;
    },
    saveDiscoveryState: (next) => {
      discovery = next;
    },
    discoveryState: () => discovery,
  };
  return { provider, credentials: () => credentials, authorizationUrl: () => authorizationUrl };
};

export type OAuthFetch = typeof globalThis.fetch;

export const defaultOAuthFetch: OAuthFetch = (input, init) => globalThis.fetch(input, init);

/** Finds the service's sign-in, registers T4 with it, and returns the page to open. */
export const beginOAuthSignIn = async (
  session: OAuthSession,
  serverUrl: string,
  fetchFn: OAuthFetch,
): Promise<URL> => {
  await auth(session.provider, { serverUrl, fetchFn });
  const url = session.authorizationUrl();
  if (url === undefined) throw new Error("The service did not offer a sign-in page.");
  return url;
};

/** Trades the code the browser came back with for tokens, which land in the session. */
export const completeOAuthSignIn = async (
  session: OAuthSession,
  serverUrl: string,
  authorizationCode: string,
  fetchFn: OAuthFetch,
): Promise<void> => {
  await auth(session.provider, { serverUrl, authorizationCode, fetchFn });
};
