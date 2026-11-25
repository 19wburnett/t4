import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS muse_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      muse_chat_id TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS muse_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES muse_threads(id),
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      content TEXT NOT NULL,
      attachments TEXT NOT NULL DEFAULT '[]',
      context TEXT NOT NULL DEFAULT '{}',
      action_url TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'claimed', 'answered', 'failed', 'sent')),
      reply_kind TEXT CHECK (reply_kind IN ('answer', 'question', 'approval_needed', 'error', 'ack', 'progress')),
      in_reply_to TEXT REFERENCES muse_messages(id),
      client_request_id TEXT UNIQUE,
      claimed_at TEXT,
      claim_token TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      answered_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_muse_messages_status_created
    ON muse_messages(status, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_muse_messages_thread_created
    ON muse_messages(thread_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS muse_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Only a SHA-256 of the bridge token is kept, so the token is shown once and never readable again.
  yield* sql`
    CREATE TABLE IF NOT EXISTS muse_bridge_token (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
