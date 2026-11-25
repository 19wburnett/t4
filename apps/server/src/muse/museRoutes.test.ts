import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as MuseBridge from "./MuseBridge.ts";
import * as MuseRoutes from "./museRoutes.ts";

const withBridge = Effect.fn("test.muse")(function* () {
  const bridge = yield* MuseBridge.MuseBridge;
  const sql = yield* SqlClient.SqlClient;
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        MuseRoutes.layer.pipe(Layer.provide(Layer.succeed(MuseBridge.MuseBridge, bridge))),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  );
  const { token } = yield* bridge.issueToken;
  const request = Effect.fn("test.muse.request")(
    (
      path: string,
      options?: {
        method?: "POST";
        body?: object;
        public?: boolean;
      },
    ) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/muse${path}`, {
            ...(options?.method === undefined ? {} : { method: options.method }),
            headers: {
              "content-type": "application/json",
              ...(options?.public ? {} : { authorization: `Bearer ${token}` }),
            },
            ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
          }),
        ),
      ),
  );
  const threadId = "4b7fd6cc-f597-4db1-92eb-66e7f5e76b72";
  const threadInput = { threadId, title: "Workshop" };
  yield* bridge.createThread(threadInput);
  const input = {
    threadId,
    content: "Private question",
    clientRequestId: "test-request",
    context: { open_thread_id: "t4-thread", selected_files: ["src/app.ts"] },
  };
  return { bridge, sql, request, threadId, threadInput, input };
});

const testLayer = MuseBridge.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

describe("Muse bridge HTTP and queue", () => {
  it.effect("lists the queued inbound once and exposes only counts on public ping", () =>
    Effect.gen(function* () {
      const { bridge, input, request } = yield* withBridge();
      const [message, duplicate] = yield* Effect.all([bridge.send(input), bridge.send(input)], {
        concurrency: "unbounded",
      });
      expect(message.id).toBe(duplicate.id);
      const queued = yield* request("/messages?status=queued&order=created_at.asc&limit=20");
      expect(queued.status).toBe(200);
      expect(yield* Effect.promise(() => queued.json())).toEqual([
        expect.objectContaining({
          id: message.id,
          thread_id: input.threadId,
          content: input.content,
          context: input.context,
        }),
      ]);
      const ping = yield* request("/ping", { public: true });
      expect(yield* Effect.promise(() => ping.json())).toEqual({
        queued: 1,
        oldest_queued_at: message.createdAt,
      });
      const unauthorized = yield* request("/messages", { public: true });
      expect(unauthorized.status).toBe(401);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "claims once, keeps progress pending, and commits one final reply with its approval URL",
    () =>
      Effect.gen(function* () {
        const { bridge, input, request, threadId } = yield* withBridge();
        const message = yield* bridge.send(input);
        const base = `/messages/${message.id}`;
        const [first, second] = yield* Effect.all(
          [
            request(`${base}/claim`, { method: "POST" }),
            request(`${base}/claim`, { method: "POST" }),
          ],
          { concurrency: "unbounded" },
        );
        const [claim, conflict] = first.status === 200 ? [first, second] : [second, first];
        expect(claim.status).toBe(200);
        expect(conflict.status).toBe(409);
        expect(yield* Effect.promise(() => conflict.json())).toEqual({ error: "already_claimed" });
        const { claim_token } = yield* Effect.promise(
          () => claim.json() as Promise<{ claim_token: string }>,
        );
        const body = {
          claim_token,
          content: "Approval required",
          reply_kind: "approval_needed",
          action_url: "https://muse.example.test/approve/1",
        };
        const wrong = yield* request(`${base}/reply`, {
          method: "POST",
          body: { ...body, claim_token: "wrong" },
        });
        expect(wrong.status).toBe(409);
        for (const content of ["Received", "Checking"]) {
          const progress = yield* request(`${base}/progress`, {
            method: "POST",
            body: { claim_token, content },
          });
          expect(progress.status).toBe(201);
        }
        const pending = yield* bridge.thread(threadId);
        expect(pending.messages.map(({ status, replyKind }) => [status, replyKind])).toEqual([
          ["claimed", null],
          ["sent", "ack"],
          ["sent", "progress"],
        ]);
        const replies = yield* Effect.all(
          [
            request(`${base}/reply`, { method: "POST", body }),
            request(`${base}/reply`, { method: "POST", body }),
          ],
          { concurrency: "unbounded" },
        );
        expect(replies.map(({ status }) => status).sort()).toEqual([201, 409]);
        const answered = yield* bridge.thread(threadId);
        expect(answered.messages[0]?.status).toBe("answered");
        expect(
          answered.messages.filter(({ replyKind }) => replyKind === "approval_needed"),
        ).toEqual([
          expect.objectContaining({
            status: "sent",
            inReplyTo: message.id,
            actionUrl: body.action_url,
          }),
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requeues an expired claim and invalidates the old claim token", () =>
    Effect.gen(function* () {
      const { bridge, input, request, sql } = yield* withBridge();
      const message = yield* bridge.send(input);
      const claimPath = `/messages/${message.id}/claim`;
      const firstClaim = yield* request(claimPath, { method: "POST" });
      expect(firstClaim.status).toBe(200);
      const claimed = yield* Effect.promise(
        () => firstClaim.json() as Promise<{ claim_token: string }>,
      );
      yield* sql`UPDATE muse_messages SET claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = ${message.id}`;
      const ping = yield* request("/ping", { public: true });
      expect(yield* Effect.promise(() => ping.json())).toMatchObject({ queued: 1 });
      const secondClaim = yield* request(claimPath, { method: "POST" });
      expect(secondClaim.status).toBe(200);
      const reclaimed = yield* Effect.promise(
        () => secondClaim.json() as Promise<{ claim_token: string }>,
      );
      expect(reclaimed.claim_token).not.toBe(claimed.claim_token);
      const rejected = yield* request(`/messages/${message.id}/fail`, {
        method: "POST",
        body: { claim_token: claimed.claim_token, error: "expired" },
      });
      expect(rejected.status).toBe(409);
      const failed = yield* request(`/messages/${message.id}/fail`, {
        method: "POST",
        body: { claim_token: reclaimed.claim_token, error: "Failed to answer" },
      });
      expect(failed.status).toBe(200);
      expect((yield* bridge.thread(input.threadId)).messages[0]).toMatchObject({
        status: "failed",
        error: "Failed to answer",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "updates heartbeat with bridge auth and creates a titled thread only once per request ID",
    () =>
      Effect.gen(function* () {
        const { bridge, request, threadInput, sql } = yield* withBridge();
        expect((yield* bridge.list).lastSeenAt).toBeNull();
        const denied = yield* request("/heartbeat", { method: "POST", public: true });
        expect(denied.status).toBe(401);
        const first = yield* request("/heartbeat", { method: "POST" });
        expect(first.status).toBe(200);
        expect((yield* bridge.list).lastSeenAt).toEqual(expect.any(String));
        yield* sql`UPDATE muse_meta SET value = '2000-01-01T00:00:00.000Z' WHERE key = 'last_seen_at'`;
        const second = yield* request("/heartbeat", { method: "POST" });
        expect(second.status).toBe(200);
        const newThread = {
          threadId: "4b7fd6cc-f597-4db1-92eb-66e7f5e76b73",
          title: "Second thread",
        };
        yield* Effect.all([bridge.createThread(newThread), bridge.createThread(newThread)], {
          concurrency: "unbounded",
        });
        const list = yield* bridge.list;
        expect(list.lastSeenAt).not.toBe("2000-01-01T00:00:00.000Z");
        expect(list.threads).toEqual([newThread, threadInput]);
        yield* bridge.issueToken;
        const revoked = yield* request("/heartbeat", { method: "POST" });
        expect(revoked.status).toBe(401);
      }).pipe(Effect.provide(testLayer)),
  );
});
