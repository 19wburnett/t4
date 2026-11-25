// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no timingSafeEqual or randomUUID.
import * as NodeCrypto from "node:crypto";

import {
  MuseMessageContext,
  type MuseCreateThreadInput,
  type MuseThreadList,
  type MuseThreadSummary,
  type MuseFinalReplyKind,
  type MuseBridgeTokenIssued,
  type MuseBridgeTokenStatus,
  type MuseMessage,
  type MuseReplyKind,
  type MuseSendInput,
  type MuseThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The queue between T4 and Muse, which has no inbound API: T4 queues Weston's messages, Muse
 * polls `/api/muse/ping`, claims one, and writes its reply back. See `museRoutes.ts`.
 */

const CLAIM_LEASE = Duration.minutes(10);
const THREAD_HISTORY_LIMIT = 200;

export class MuseQueueError extends Schema.TaggedError<MuseQueueError>()("MuseQueueError", {
  reason: Schema.Literals(["not_found", "already_claimed", "invalid_claim", "storage"]),
  message: Schema.String,
}) {}

/** A queued message as Muse reads it. The claim token only ever goes to the claimer. */
export interface MuseQueueMessage {
  readonly id: string;
  readonly thread_id: string;
  readonly content: string;
  readonly attachments: ReadonlyArray<unknown>;
  readonly context: MuseMessageContext;
  readonly status: string;
  readonly created_at: string;
  readonly claimed_at: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly thread_id: string;
  readonly direction: "inbound" | "outbound";
  readonly content: string;
  readonly attachments: string;
  readonly context: string;
  readonly action_url: string | null;
  readonly status: MuseMessage["status"];
  readonly reply_kind: MuseReplyKind | null;
  readonly in_reply_to: string | null;
  readonly client_request_id: string | null;
  readonly claimed_at: string | null;
  readonly claim_token: string | null;
  readonly error: string | null;
  readonly created_at: string;
  readonly answered_at: string | null;
}

const parseAttachments = (json: string): ReadonlyArray<unknown> => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const ContextJson = Schema.fromJsonString(MuseMessageContext);
const decodeContext = Schema.decodeUnknownSync(ContextJson);
const encodeContext = Schema.encodeSync(ContextJson);

const toQueueMessage = (row: MessageRow): MuseQueueMessage => ({
  id: row.id,
  thread_id: row.thread_id,
  content: row.content,
  attachments: parseAttachments(row.attachments),
  context: decodeContext(row.context),
  status: row.status,
  created_at: row.created_at,
  claimed_at: row.claimed_at,
});

const toMuseMessage = (row: MessageRow): MuseMessage => ({
  id: row.id,
  direction: row.direction,
  content: row.content,
  status: row.status,
  replyKind: row.reply_kind,
  inReplyTo: row.in_reply_to,
  error: row.error,
  createdAt: row.created_at,
  answeredAt: row.answered_at,
  actionUrl: row.action_url,
  context: decodeContext(row.context),
});

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();
const newToken = (prefix: string) => `${prefix}${NodeCrypto.randomBytes(32).toString("base64url")}`;

const queueError = (reason: MuseQueueError["reason"], message: string) =>
  new MuseQueueError({ reason, message });

const storageFailure = () => Effect.fail(queueError("storage", "Muse bridge storage failed."));

export class MuseBridge extends Context.Service<
  MuseBridge,
  {
    readonly ping: Effect.Effect<
      { readonly queued: number; readonly oldest_queued_at: string | null },
      MuseQueueError
    >;
    readonly listQueued: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<MuseQueueMessage>, MuseQueueError>;
    readonly claim: (
      id: string,
    ) => Effect.Effect<MuseQueueMessage & { readonly claim_token: string }, MuseQueueError>;
    readonly reply: (
      id: string,
      input: {
        readonly claimToken: string;
        readonly content: string;
        readonly replyKind: MuseFinalReplyKind;
        readonly actionUrl?: string | undefined;
      },
    ) => Effect.Effect<{ readonly outbound_message_id: string }, MuseQueueError>;
    readonly progress: (
      id: string,
      input: { readonly claimToken: string; readonly content: string },
    ) => Effect.Effect<{ readonly outbound_message_id: string }, MuseQueueError>;
    readonly heartbeat: Effect.Effect<void, MuseQueueError>;
    readonly fail: (
      id: string,
      input: { readonly claimToken: string; readonly error: string },
    ) => Effect.Effect<void, MuseQueueError>;
    /** Whether `token` is the current bridge token. False when none is issued. */
    readonly authorize: (token: string) => Effect.Effect<boolean, MuseQueueError>;
    readonly list: Effect.Effect<MuseThreadList, MuseQueueError>;
    readonly createThread: (
      input: typeof MuseCreateThreadInput.Type,
    ) => Effect.Effect<typeof MuseThreadSummary.Type, MuseQueueError>;
    readonly thread: (id: string) => Effect.Effect<MuseThread, MuseQueueError>;
    readonly send: (input: MuseSendInput) => Effect.Effect<MuseMessage, MuseQueueError>;
    readonly tokenStatus: Effect.Effect<MuseBridgeTokenStatus, MuseQueueError>;
    readonly issueToken: Effect.Effect<MuseBridgeTokenIssued, MuseQueueError>;
    readonly revokeToken: Effect.Effect<MuseBridgeTokenStatus, MuseQueueError>;
  }
>()("t3/muse/MuseBridge") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readMessage = (id: string) =>
    sql<MessageRow>`SELECT * FROM muse_messages WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
    );

  /** Lazily returns claims Muse abandoned to the queue; run before anything reads the queue. */
  const releaseStaleClaims = Effect.gen(function* () {
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, CLAIM_LEASE));
    yield* sql`
      UPDATE muse_messages
      SET status = 'queued', claim_token = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND direction = 'inbound' AND claimed_at < ${cutoff}
    `;
  });

  const ping = Effect.gen(function* () {
    yield* releaseStaleClaims;
    const rows = yield* sql<{ readonly queued: number; readonly oldest: string | null }>`
      SELECT COUNT(*) AS queued, MIN(created_at) AS oldest
      FROM muse_messages WHERE status = 'queued' AND direction = 'inbound'
    `;
    return { queued: Number(rows[0]?.queued ?? 0), oldest_queued_at: rows[0]?.oldest ?? null };
  }).pipe(Effect.catchTags({ SqlError: storageFailure }), Effect.withSpan("MuseBridge.ping"));

  const listQueued = Effect.fn("MuseBridge.listQueued")(
    function* (limit: number) {
      yield* releaseStaleClaims;
      const rows = yield* sql<MessageRow>`
      SELECT * FROM muse_messages
      WHERE status = 'queued' AND direction = 'inbound'
      ORDER BY created_at ASC, rowid ASC
      LIMIT ${limit}
    `;
      return rows.map(toQueueMessage);
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const claim = Effect.fn("MuseBridge.claim")(
    function* (id: string) {
      yield* releaseStaleClaims;
      const claimToken = newToken("claim_");
      const claimedAt = yield* nowIso;
      const [row] = yield* sql<MessageRow>`
      UPDATE muse_messages
      SET status = 'claimed', claimed_at = ${claimedAt}, claim_token = ${claimToken}
      WHERE id = ${id} AND direction = 'inbound' AND status = 'queued'
      RETURNING *
    `;
      if (row === undefined) {
        return yield* queueError("already_claimed", "The message is not queued.");
      }
      return { ...toQueueMessage(row), claim_token: claimToken };
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  /** The inbound row, if `claimToken` holds its live claim. */
  const heldClaim = Effect.fn("MuseBridge.heldClaim")(function* (id: string, claimToken: string) {
    const row = yield* readMessage(id);
    if (row === undefined || row.direction !== "inbound") {
      return yield* queueError("not_found", "No such message.");
    }
    const cutoff = DateTime.formatIso(DateTime.subtractDuration(yield* DateTime.now, CLAIM_LEASE));
    const held =
      row.status === "claimed" &&
      row.claimed_at !== null &&
      row.claimed_at >= cutoff &&
      row.claim_token !== null &&
      NodeCrypto.timingSafeEqual(sha256(row.claim_token), sha256(claimToken));
    if (!held)
      return yield* queueError("invalid_claim", "The claim token does not hold this message.");
    return row;
  });

  const recordReply = Effect.fn("MuseBridge.recordReply")(
    function* (
      id: string,
      input: { readonly claimToken: string; readonly content: string },
      final?: { readonly replyKind: MuseFinalReplyKind; readonly actionUrl?: string | undefined },
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const inbound = yield* heldClaim(id, input.claimToken);
          const now = yield* nowIso;
          const outboundId = NodeCrypto.randomUUID();
          const replyKind =
            final?.replyKind ??
            (yield* sql<{ readonly kind: "ack" | "progress" }>`
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM muse_messages
          WHERE thread_id = ${inbound.thread_id} AND in_reply_to = ${id}
            AND reply_kind IN ('ack', 'progress') AND created_at >= ${inbound.claimed_at}
        ) THEN 'progress' ELSE 'ack' END AS kind
      `)[0]?.kind ??
            "ack";
          yield* sql`
        INSERT INTO muse_messages (
          id, thread_id, direction, content, status, reply_kind, in_reply_to, created_at, action_url
        ) VALUES (
          ${outboundId}, ${inbound.thread_id}, 'outbound', ${input.content}, 'sent',
          ${replyKind}, ${id}, ${now}, ${final?.actionUrl ?? null}
        )
      `;
          if (final) {
            yield* sql`
          UPDATE muse_messages
          SET status = 'answered', answered_at = ${now}, claim_token = NULL
          WHERE id = ${id}
        `;
          }
          return { outbound_message_id: outboundId };
        }),
      );
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const heartbeat = Effect.gen(function* () {
    const now = yield* nowIso;
    yield* sql`
      INSERT INTO muse_meta (key, value, updated_at) VALUES ('last_seen_at', ${now}, ${now})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `;
  }).pipe(Effect.catchTags({ SqlError: storageFailure }), Effect.withSpan("MuseBridge.heartbeat"));

  const fail: MuseBridge["Service"]["fail"] = Effect.fn("MuseBridge.fail")(
    function* (id, input) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* heldClaim(id, input.claimToken);
          yield* sql`
            UPDATE muse_messages
            SET status = 'failed', error = ${input.error}, claim_token = NULL
            WHERE id = ${id}
          `;
        }),
      );
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const authorize = Effect.fn("MuseBridge.authorize")(
    function* (token: string) {
      const rows = yield* sql<{ readonly token_hash: string }>`
      SELECT token_hash FROM muse_bridge_token WHERE id = 1
    `;
      const stored = rows[0];
      if (stored === undefined) return false;
      return NodeCrypto.timingSafeEqual(Buffer.from(stored.token_hash, "hex"), sha256(token));
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const list = Effect.gen(function* () {
    const threads = yield* sql<typeof MuseThreadSummary.Type>`
      SELECT id AS threadId, title FROM muse_threads
      WHERE archived_at IS NULL ORDER BY created_at DESC, rowid DESC
    `;
    const presence = yield* sql<{ readonly value: string }>`
      SELECT value FROM muse_meta WHERE key = 'last_seen_at'
    `;
    return { threads, lastSeenAt: presence[0]?.value ?? null };
  }).pipe(Effect.catchTags({ SqlError: storageFailure }), Effect.withSpan("MuseBridge.list"));

  const createThread = Effect.fn("MuseBridge.createThread")(
    function* (input: typeof MuseCreateThreadInput.Type) {
      yield* sql`
      INSERT INTO muse_threads (id, title, created_at)
      VALUES (${input.threadId}, ${input.title}, ${yield* nowIso})
      ON CONFLICT (id) DO NOTHING
    `;
      return yield* findThread(input.threadId);
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const findThread = Effect.fn("MuseBridge.findThread")(function* (id: string) {
    const [thread] = yield* sql<typeof MuseThreadSummary.Type>`
      SELECT id AS threadId, title FROM muse_threads WHERE id = ${id} AND archived_at IS NULL
    `;
    if (!thread) return yield* queueError("not_found", "No such Muse thread.");
    return thread;
  });

  const thread = Effect.fn("MuseBridge.thread")(
    function* (id: string) {
      const current = yield* findThread(id);
      const rows = yield* sql<MessageRow>`
      WITH recent AS (
        SELECT id FROM muse_messages WHERE thread_id = ${id} AND direction = 'inbound'
        ORDER BY created_at DESC, rowid DESC LIMIT ${THREAD_HISTORY_LIMIT}
      )
      SELECT * FROM muse_messages
      WHERE thread_id = ${id} AND (id IN recent OR in_reply_to IN recent OR status IN ('queued', 'claimed'))
      ORDER BY created_at ASC, rowid ASC
    `;
      return { ...current, messages: rows.map(toMuseMessage) };
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const send = Effect.fn("MuseBridge.send")(
    function* (input: MuseSendInput) {
      yield* findThread(input.threadId);
      yield* sql`
      INSERT INTO muse_messages (
        id, thread_id, direction, content, status, context, client_request_id, created_at
      ) VALUES (
        ${NodeCrypto.randomUUID()}, ${input.threadId}, 'inbound', ${input.content}, 'queued',
        ${encodeContext(input.context ?? {})}, ${input.clientRequestId}, ${yield* nowIso}
      )
      ON CONFLICT (client_request_id) DO NOTHING
    `;
      const [row] = yield* sql<MessageRow>`
      SELECT * FROM muse_messages WHERE client_request_id = ${input.clientRequestId}
    `;
      if (row?.thread_id !== input.threadId)
        return yield* queueError("storage", "Message request ID conflicts with another thread.");
      return toMuseMessage(row);
    },
    Effect.catchTags({ SqlError: storageFailure }),
  );

  const tokenStatus = sql<{ readonly created_at: string }>`
    SELECT created_at FROM muse_bridge_token WHERE id = 1
  `.pipe(
    Effect.map((rows) => ({ createdAt: rows[0]?.created_at ?? null })),
    Effect.catchTags({ SqlError: storageFailure }),
    Effect.withSpan("MuseBridge.tokenStatus"),
  );

  const issueToken = Effect.gen(function* () {
    const token = newToken("t4muse_");
    const createdAt = yield* nowIso;
    yield* sql`
      INSERT INTO muse_bridge_token (id, token_hash, created_at)
      VALUES (1, ${sha256(token).toString("hex")}, ${createdAt})
      ON CONFLICT (id) DO UPDATE SET
        token_hash = excluded.token_hash,
        created_at = excluded.created_at
    `;
    return { token, createdAt };
  }).pipe(Effect.catchTags({ SqlError: storageFailure }), Effect.withSpan("MuseBridge.issueToken"));

  const revokeToken = sql`DELETE FROM muse_bridge_token WHERE id = 1`.pipe(
    Effect.as({ createdAt: null }),
    Effect.catchTags({ SqlError: storageFailure }),
    Effect.withSpan("MuseBridge.revokeToken"),
  );

  return MuseBridge.of({
    ping,
    listQueued,
    claim,
    reply: Effect.fn("MuseBridge.reply")((id, input) => recordReply(id, input, input)),
    progress: Effect.fn("MuseBridge.progress")((id, input) => recordReply(id, input)),
    heartbeat,
    fail,
    authorize,
    list,
    createThread,
    thread,
    send,
    tokenStatus,
    issueToken,
    revokeToken,
  });
});

export const layer = Layer.effect(MuseBridge, make);
