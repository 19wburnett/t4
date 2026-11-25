import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Weston's Muse agent has no inbound API, so T4 keeps a queue Muse polls over HTTP
 * (`/api/muse/*`). Clients see their environment’s Muse threads and the bridge token's status here.
 */
export const MuseMessageStatus = Schema.Literals([
  "queued",
  "claimed",
  "answered",
  "failed",
  "sent",
]);
export type MuseMessageStatus = typeof MuseMessageStatus.Type;

export const MuseFinalReplyKind = Schema.Literals([
  "answer",
  "question",
  "approval_needed",
  "error",
]);
export type MuseFinalReplyKind = typeof MuseFinalReplyKind.Type;
export const MuseReplyKind = Schema.Union([
  MuseFinalReplyKind,
  Schema.Literals(["ack", "progress"]),
]);
export const MuseMessageContext = Schema.Struct({
  t4_project_id: Schema.optional(Schema.String),
  project_title: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  open_thread_id: Schema.optional(Schema.String),
  open_thread_title: Schema.optional(Schema.String),
  selected_files: Schema.optional(Schema.Array(Schema.String)),
});
export type MuseMessageContext = typeof MuseMessageContext.Type;
export type MuseReplyKind = typeof MuseReplyKind.Type;

export const MuseMessage = Schema.Struct({
  id: Schema.String,
  direction: Schema.Literals(["inbound", "outbound"]),
  content: Schema.String,
  status: MuseMessageStatus,
  replyKind: Schema.NullOr(MuseReplyKind),
  inReplyTo: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  actionUrl: Schema.NullOr(Schema.String),
  context: MuseMessageContext,
  answeredAt: Schema.NullOr(Schema.String),
});
export type MuseMessage = typeof MuseMessage.Type;

export const MuseThreadId = Schema.Struct({ threadId: Schema.String });
export const MuseThreadSummary = Schema.Struct({ ...MuseThreadId.fields, title: Schema.String });
export const MuseThreadList = Schema.Struct({
  threads: Schema.Array(MuseThreadSummary),
  lastSeenAt: Schema.NullOr(Schema.String),
});
export type MuseThreadList = typeof MuseThreadList.Type;
export const MuseCreateThreadInput = Schema.Struct({
  threadId: Schema.String.check(Schema.isUUID()),
  title: TrimmedNonEmptyString,
});

export const MuseThread = Schema.Struct({
  ...MuseThreadSummary.fields,
  messages: Schema.Array(MuseMessage),
});
export type MuseThread = typeof MuseThread.Type;

/** A tap's `clientRequestId` is reused on retry, so a double send stores one message. */
export const MuseSendInput = Schema.Struct({
  ...MuseThreadId.fields,
  context: Schema.optional(MuseMessageContext),
  content: TrimmedNonEmptyString,
  clientRequestId: TrimmedNonEmptyString,
});
export type MuseSendInput = typeof MuseSendInput.Type;

export const MuseBridgeTokenStatus = Schema.Struct({
  createdAt: Schema.NullOr(Schema.String),
});
export type MuseBridgeTokenStatus = typeof MuseBridgeTokenStatus.Type;

/** The only time the token leaves the server; it is stored as a hash. */
export const MuseBridgeTokenIssued = Schema.Struct({
  token: Schema.String,
  createdAt: Schema.String,
});
export type MuseBridgeTokenIssued = typeof MuseBridgeTokenIssued.Type;

export class MuseBridgeError extends Schema.TaggedError<MuseBridgeError>()("MuseBridgeError", {
  message: Schema.String,
}) {}
