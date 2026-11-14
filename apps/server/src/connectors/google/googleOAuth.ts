// Plain promises over fetch, called through the promise-based ConnectorClient like the MCP SDK.
// @effect-diagnostics globalFetch:off globalDate:off
// T4's Google app is a web client whose secret lives only on the hosted site. Google redirects
// there; the site hands the code back to the T4 server that started the sign-in, and the server
// trades it for tokens through the site's token endpoint with its PKCE verifier.

export const GOOGLE_CLIENT_ID =
  "309622898753-icaqagjmojqipmgd3nihecci12prnhkq.apps.googleusercontent.com";
const DEFAULT_GOOGLE_BROKER_URL = "https://t4-cyan.vercel.app";
export const GOOGLE_CALLBACK_PATH = "/api/connectors/google/callback";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/contacts.readonly",
];

export interface GoogleTokens {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  readonly refreshToken: string | undefined;
}

export interface GoogleBroker {
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
}

export const defaultGoogleBroker = (): GoogleBroker => ({
  url: process.env.T4_GOOGLE_BROKER_URL ?? DEFAULT_GOOGLE_BROKER_URL,
  fetch: (input, init) => globalThis.fetch(input, init),
});

const base64Url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const pkceChallenge = async (verifier: string) =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

/** The hosted site reads `r` to know where to send the code; `n` makes the state unguessable. */
export const encodeState = (input: { readonly returnUrl: string; readonly nonce: string }) =>
  base64Url(new TextEncoder().encode(JSON.stringify({ v: 1, r: input.returnUrl, n: input.nonce })));

export const callbackUrl = (httpBaseUrl: string) => new URL(GOOGLE_CALLBACK_PATH, httpBaseUrl).href;

export const authorizationUrl = (input: {
  readonly brokerUrl: string;
  readonly state: string;
  readonly codeChallenge: string;
}) => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: new URL("/api/google/callback", input.brokerUrl).href,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // Without it Google omits the refresh token when the user signed in to T4 before.
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
  }).toString();
  return url.href;
};

interface TokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

class GoogleAuthError extends Error {
  override readonly name = "GoogleAuthError";
}

const requestTokens = async (broker: GoogleBroker, body: Record<string, string>) => {
  const response = await broker.fetch(new URL("/api/google/token", broker.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || json.access_token === undefined) {
    throw new GoogleAuthError(
      json.error_description ?? json.error ?? `Google sign-in failed (${response.status}).`,
    );
  }
  return {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token,
  } satisfies GoogleTokens;
};

export const exchangeCode = (
  broker: GoogleBroker,
  input: { readonly code: string; readonly codeVerifier: string },
) =>
  requestTokens(broker, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
  });

export const refreshTokens = (broker: GoogleBroker, refreshToken: string) =>
  requestTokens(broker, { grant_type: "refresh_token", refresh_token: refreshToken });
