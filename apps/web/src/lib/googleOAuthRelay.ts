// Shared by the hosted site's /api/google/* functions. T4 servers live at addresses Google cannot
// pre-register, so Google returns to this site, which hands the reply to the server named in the
// state. That server alone holds the PKCE verifier, so a forwarded code is useless anywhere else.

const SERVER_CALLBACK_PATH = "/api/connectors/google/callback";

/** Where the sign-in started, or null for a state this site should not act on. */
export function parseRelayState(state: string | null): URL | null {
  if (state === null || state.length > 2048) return null;
  try {
    const json = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(state.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
          char.charCodeAt(0),
        ),
      ),
    ) as { v?: unknown; r?: unknown };
    if (json.v !== 1 || typeof json.r !== "string") return null;
    const url = new URL(json.r);
    const valid =
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === SERVER_CALLBACK_PATH &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    return valid ? url : null;
  } catch {
    return null;
  }
}

export function forwardUrl(
  target: URL,
  params: { readonly state: string; readonly code: string | null; readonly error: string | null },
): string {
  const url = new URL(target);
  url.searchParams.set("state", params.state);
  if (params.code !== null) url.searchParams.set("code", params.code);
  if (params.error !== null) url.searchParams.set("error", params.error);
  return url.href;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function relayPage(input: {
  readonly title: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly href: string } | undefined;
}): string {
  const action = input.action
    ? `<p><a href="${escapeHtml(input.action.href)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1a56db;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(input.action.label)}</a></p>`
    : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title)}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px;color:#16191f;background:#fff"><h1 style="font-size:1.4rem">${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${action}</body></html>`;
}
