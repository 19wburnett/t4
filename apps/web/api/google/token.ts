// Holds T4's Google client secret so it never ships inside T4. T4 servers send the code with the
// PKCE verifier only they know, or a refresh token they already hold.

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function POST(request: Request): Promise<Response> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ error: "server_error", error_description: "Google is not set up here." }, 500);
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (key: string) => (typeof body?.[key] === "string" ? (body[key] as string) : null);
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  if (text("grant_type") === "authorization_code" && text("code") && text("code_verifier")) {
    form.set("grant_type", "authorization_code");
    form.set("code", text("code")!);
    form.set("code_verifier", text("code_verifier")!);
    form.set("redirect_uri", new URL("/api/google/callback", request.url).href);
  } else if (text("grant_type") === "refresh_token" && text("refresh_token")) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", text("refresh_token")!);
  } else {
    return json({ error: "invalid_request", error_description: "Unsupported token request." }, 400);
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  return json(await response.json().catch(() => ({ error: "bad_response" })), response.status);
}
