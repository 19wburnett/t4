import { forwardUrl, parseRelayState, relayPage } from "../../src/lib/googleOAuthRelay";

const html = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });

/** Google's redirect for T4 sign-ins: confirms the T4 server, then hands it the reply. */
export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const target = parseRelayState(state);
  if (state === null || target === null) {
    return html(
      relayPage({
        title: "Google sign-in failed",
        message: "This link did not come from T4. Start connecting Google again from T4.",
      }),
      400,
    );
  }
  const code = params.get("code");
  const href = forwardUrl(target, { state, code, error: params.get("error") });
  // A cancelled sign-in carries nothing worth stealing, so it goes straight back.
  if (code === null) return Response.redirect(href, 302);
  return html(
    relayPage({
      title: "Finish connecting Google",
      message: `Send this sign-in to your T4 at ${target.host}? If you did not start connecting Google from T4 just now, close this tab.`,
      action: { label: `Continue to ${target.host}`, href },
    }),
    200,
  );
}
