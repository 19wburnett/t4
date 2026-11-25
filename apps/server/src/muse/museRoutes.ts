import { MuseFinalReplyKind } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { MuseBridge, type MuseQueueError } from "./MuseBridge.ts";

const MUSE_ROUTE_PREFIX = "/api/muse";
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });

const STATUS_BY_REASON: Record<MuseQueueError["reason"], number> = {
  not_found: 404,
  already_claimed: 409,
  invalid_claim: 409,
  storage: 500,
};
const queueErrorResponse = (error: MuseQueueError) =>
  Effect.succeed(json({ error: error.reason }, STATUS_BY_REASON[error.reason]));

const ReplyBody = Schema.Struct({
  claim_token: Schema.String,
  content: Schema.String,
  reply_kind: MuseFinalReplyKind,
  action_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const ProgressBody = Schema.Struct({ claim_token: Schema.String, content: Schema.String });
const isWebUrl = (value: string) => {
  const url = URL.parse(value);
  return url?.protocol === "https:" || url?.protocol === "http:";
};
const FailBody = Schema.Struct({ claim_token: Schema.String, error: Schema.String });

const readBody = Effect.fn("MuseRoutes.readBody")(function* <S extends Schema.Top>(schema: S) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
  );
  return yield* Schema.decodeEffect(schema)(body);
}, Effect.option);

/** Runs `handler` only for a request carrying the current bridge token. */
const withBridgeToken = Effect.fn("MuseRoutes.withBridgeToken")(function* <E, R>(
  bridge: MuseBridge["Service"],
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
  const authorized =
    match?.[1] === undefined
      ? false
      : yield* bridge.authorize(match[1]).pipe(Effect.orElseSucceed(() => false));
  if (!authorized) return json({ error: "unauthorized" }, 401);
  return yield* handler;
});

const messageId = HttpRouter.params.pipe(Effect.map((params) => params.id ?? ""));

/**
 * Muse's side of the bridge. `/ping` is public and says only how much is queued, since the
 * script polling it holds no secrets; everything else needs the bridge token from Settings.
 */
const routes = (bridge: MuseBridge["Service"]) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${MUSE_ROUTE_PREFIX}/ping`,
      bridge.ping.pipe(
        Effect.map((counts) => json(counts)),
        Effect.catchTags({ MuseQueueError: queueErrorResponse }),
      ),
    ),
    HttpRouter.add(
      "GET",
      `${MUSE_ROUTE_PREFIX}/messages`,
      withBridgeToken(
        bridge,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
          const status = params.get("status") ?? "queued";
          const order = params.get("order") ?? "created_at.asc";
          if (status !== "queued" || order !== "created_at.asc") {
            return json({ error: "unsupported_query" }, 400);
          }
          const limit = Number(params.get("limit") ?? DEFAULT_LIST_LIMIT);
          if (!Number.isInteger(limit) || limit < 1) return json({ error: "invalid_limit" }, 400);
          return yield* bridge.listQueued(Math.min(limit, MAX_LIST_LIMIT)).pipe(
            Effect.map((messages) => json(messages)),
            Effect.catchTags({ MuseQueueError: queueErrorResponse }),
          );
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${MUSE_ROUTE_PREFIX}/messages/:id/claim`,
      withBridgeToken(
        bridge,
        Effect.gen(function* () {
          return yield* bridge.claim(yield* messageId).pipe(
            Effect.map((message) => json(message)),
            Effect.catchTags({ MuseQueueError: queueErrorResponse }),
          );
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${MUSE_ROUTE_PREFIX}/messages/:id/reply`,
      withBridgeToken(
        bridge,
        Effect.gen(function* () {
          const body = yield* readBody(ReplyBody);
          if (Option.isNone(body)) return json({ error: "invalid_body" }, 400);
          const actionUrl = body.value.action_url ?? undefined;
          if (
            actionUrl !== undefined &&
            (body.value.reply_kind !== "approval_needed" || !isWebUrl(actionUrl))
          ) {
            return json({ error: "invalid_action_url" }, 400);
          }
          return yield* bridge
            .reply(yield* messageId, {
              claimToken: body.value.claim_token,
              content: body.value.content,
              replyKind: body.value.reply_kind,
              actionUrl,
            })
            .pipe(
              Effect.map((result) => json(result, 201)),
              Effect.catchTags({ MuseQueueError: queueErrorResponse }),
            );
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${MUSE_ROUTE_PREFIX}/messages/:id/progress`,
      withBridgeToken(
        bridge,
        Effect.gen(function* () {
          const body = yield* readBody(ProgressBody);
          if (Option.isNone(body)) return json({ error: "invalid_body" }, 400);
          return yield* bridge
            .progress(yield* messageId, {
              claimToken: body.value.claim_token,
              content: body.value.content,
            })
            .pipe(
              Effect.map((result) => json(result, 201)),
              Effect.catchTags({ MuseQueueError: queueErrorResponse }),
            );
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${MUSE_ROUTE_PREFIX}/heartbeat`,
      withBridgeToken(
        bridge,
        bridge.heartbeat.pipe(
          Effect.as(json({ ok: true })),
          Effect.catchTags({ MuseQueueError: queueErrorResponse }),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${MUSE_ROUTE_PREFIX}/messages/:id/fail`,
      withBridgeToken(
        bridge,
        Effect.gen(function* () {
          const body = yield* readBody(FailBody);
          if (Option.isNone(body)) return json({ error: "invalid_body" }, 400);
          return yield* bridge
            .fail(yield* messageId, { claimToken: body.value.claim_token, error: body.value.error })
            .pipe(
              Effect.as(json({ ok: true })),
              Effect.catchTags({ MuseQueueError: queueErrorResponse }),
            );
        }),
      ),
    ),
  );

export const layer = Layer.unwrap(Effect.map(MuseBridge, routes));
