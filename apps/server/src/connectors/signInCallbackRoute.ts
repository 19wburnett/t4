import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { OAUTH_CALLBACK_PATH } from "./connectorOAuth.ts";
import * as Connectors from "./Connectors.ts";
import { GOOGLE_CALLBACK_PATH } from "./google/googleOAuth.ts";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, message: string, status: number) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;line-height:1.5"><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    },
  );

/**
 * Where a browser sign-in comes back: Google's reply, forwarded by the hosted site, or an MCP
 * server's own. No session: the unguessable, single-use state is what ties it to the sign-in
 * this server started.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const connectors = yield* Connectors.Connectors;
    return Layer.mergeAll(
      HttpRouter.add("GET", GOOGLE_CALLBACK_PATH, callback(connectors)),
      HttpRouter.add("GET", OAUTH_CALLBACK_PATH, callback(connectors)),
    );
  }),
);

const callback = Effect.fn("SignInCallbackRoute.callback")(function* (
  connectors: Connectors.Connectors["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
  const state = params.get("state");
  if (state === null) return page("Sign-in failed", "The sign-in link is incomplete.", 400);
  return yield* connectors
    .signInFinish({
      state,
      code: params.get("code") ?? undefined,
      error: params.get("error") ?? undefined,
    })
    .pipe(
      Effect.match({
        onSuccess: (connector) =>
          page(
            "Connected",
            `${connector.name} is ready for your agents. You can close this tab.`,
            200,
          ),
        onFailure: (error) => page("Sign-in failed", error.message, 400),
      }),
    );
});
