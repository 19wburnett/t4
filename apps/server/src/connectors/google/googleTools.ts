// Plain promises over fetch, called through the promise-based ConnectorClient like the MCP SDK.
// @effect-diagnostics globalFetch:off globalDate:off
import type { ConnectorClient, UpstreamTool } from "../connectorClient.ts";
import { type GoogleBroker, refreshTokens } from "./googleOAuth.ts";

const MAX_TEXT_CHARS = 100_000;
const DEFAULT_LIMIT = 10;

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string> = []) => ({
  type: "object",
  properties,
  required,
});
const str = (description: string) => ({ type: "string", description });
const limit = { type: "integer", minimum: 1, maximum: 50, description: "At most this many." };
const emails = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const GOOGLE_TOOLS: ReadonlyArray<UpstreamTool> = [
  {
    name: "gmail_search",
    description: "Search Gmail with Gmail search syntax, newest first.",
    readOnly: true,
    inputSchema: object({ query: str("Such as from:ana is:unread newer_than:7d."), limit }),
  },
  {
    name: "gmail_read",
    description: "Read one Gmail message as plain text with its headers.",
    readOnly: true,
    inputSchema: object({ messageId: str("From gmail_search.") }, ["messageId"]),
  },
  {
    name: "gmail_draft",
    description: "Save a Gmail draft for the user to review and send.",
    readOnly: false,
    inputSchema: object(
      {
        to: emails("Recipients."),
        cc: emails("Copied recipients."),
        subject: str("Subject line."),
        body: str("Plain-text body."),
        threadId: str("Reply in this thread."),
      },
      ["to", "subject", "body"],
    ),
  },
  {
    name: "gmail_send",
    description: "Send an email from the user's Gmail. Prefer gmail_draft unless told to send.",
    readOnly: false,
    inputSchema: object(
      {
        to: emails("Recipients."),
        cc: emails("Copied recipients."),
        subject: str("Subject line."),
        body: str("Plain-text body."),
        threadId: str("Reply in this thread."),
      },
      ["to", "subject", "body"],
    ),
  },
  {
    name: "calendar_list_events",
    description: "List events on the user's primary Google Calendar, soonest first.",
    readOnly: true,
    inputSchema: object({
      timeMin: str("RFC 3339 start. Defaults to now."),
      timeMax: str("RFC 3339 end."),
      query: str("Free-text match."),
      limit,
    }),
  },
  {
    name: "calendar_create_event",
    description: "Create an event on the user's primary calendar. Attendees get invitations.",
    readOnly: false,
    inputSchema: object(
      {
        summary: str("Title."),
        start: str("RFC 3339 date-time, or YYYY-MM-DD for all day."),
        end: str("RFC 3339 date-time, or YYYY-MM-DD (exclusive) for all day."),
        description: str("Details."),
        location: str("Place or link."),
        attendees: emails("Guest emails."),
      },
      ["summary", "start", "end"],
    ),
  },
  {
    name: "drive_search",
    description: "Find Google Drive files by name or content, recently modified first.",
    readOnly: true,
    inputSchema: object({ query: str("Words in the file name or contents."), limit }),
  },
  {
    name: "drive_read",
    description: "Read a Drive file as text. Docs come back as text, Sheets as CSV.",
    readOnly: true,
    inputSchema: object({ fileId: str("From drive_search.") }, ["fileId"]),
  },
  {
    name: "docs_create",
    description: "Create a Google Doc with plain-text content and return its link.",
    readOnly: false,
    inputSchema: object({ title: str("Document title."), text: str("Content.") }, ["title"]),
  },
  {
    name: "contacts_search",
    description: "Look up people in the user's Google Contacts by name, email, or phone.",
    readOnly: true,
    inputSchema: object({ query: str("Name, email, or phone."), limit }, ["query"]),
  },
];

const base64UrlEncode = (text: string) =>
  Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const base64UrlDecode = (data: string) =>
  Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;

/** An RFC 5322 message Gmail accepts as `raw`, base64url-encoded. */
export const buildRawMessage = (input: {
  readonly to: ReadonlyArray<string>;
  readonly cc?: ReadonlyArray<string> | undefined;
  readonly subject: string;
  readonly body: string;
}) =>
  base64UrlEncode(
    [
      `To: ${input.to.join(", ")}`,
      ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
      `Subject: ${encodeHeader(input.subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      input.body,
    ].join("\r\n"),
  );

interface GmailPart {
  readonly mimeType?: string;
  readonly body?: { readonly data?: string };
  readonly parts?: ReadonlyArray<GmailPart>;
}

const findPart = (part: GmailPart, mimeType: string): string | undefined => {
  if (part.mimeType === mimeType && part.body?.data) return base64UrlDecode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
};

const stripHtml = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** The message's plain text, falling back to its HTML with the tags removed. */
export const messageText = (payload: GmailPart) =>
  findPart(payload, "text/plain") ??
  (() => {
    const html = findPart(payload, "text/html");
    return html === undefined ? "" : stripHtml(html);
  })();

const truncate = (text: string) =>
  text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated]` : text;

type Args = Record<string, unknown>;
const argString = (args: Args, key: string) =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const argList = (args: Args, key: string) =>
  Array.isArray(args[key]) ? (args[key] as unknown[]).filter((v) => typeof v === "string") : [];
const argLimit = (args: Args) =>
  typeof args.limit === "number"
    ? Math.min(Math.max(1, Math.floor(args.limit)), 50)
    : DEFAULT_LIMIT;
const required = (args: Args, key: string) => {
  const value = argString(args, key);
  if (value === undefined || value.trim() === "") throw new Error(`${key} is required.`);
  return value;
};

const header = (
  headers: ReadonlyArray<{ name: string; value: string }> | undefined,
  name: string,
) => headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const eventTime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value };

/** Google tools as a connector client: same shape as an MCP server, built into T4. */
export const makeGoogleClient = (input: {
  readonly refreshToken: string;
  readonly broker: GoogleBroker;
}): ConnectorClient => {
  let token: { readonly value: string; readonly expiresAtMs: number } | undefined;

  const accessToken = async (force: boolean) => {
    if (!force && token !== undefined && token.expiresAtMs - 60_000 > Date.now()) {
      return token.value;
    }
    const fresh = await refreshTokens(input.broker, input.refreshToken);
    token = { value: fresh.accessToken, expiresAtMs: fresh.expiresAtMs };
    return token.value;
  };

  const request = async (
    url: string,
    init: { readonly method?: string; readonly body?: unknown; readonly raw?: true } = {},
  ) => {
    // A 401 here means the access token lapsed before Google ran anything, so one retry is safe.
    for (const force of [false, true]) {
      const response = await input.broker.fetch(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${await accessToken(force)}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (response.status === 401 && !force) continue;
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw Object.assign(
          new Error(json.error?.message ?? `Google returned ${response.status}.`),
          { code: response.status },
        );
      }
      return init.raw ? response.text() : response.json();
    }
    throw new Error("Google refused T4's access token.");
  };

  const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";

  const handlers: Record<string, (args: Args) => Promise<unknown>> = {
    gmail_search: async (args) => {
      const query = new URLSearchParams({ maxResults: String(argLimit(args)) });
      const q = argString(args, "query");
      if (q) query.set("q", q);
      const list = (await request(`${gmail}/messages?${query}`)) as {
        messages?: ReadonlyArray<{ id: string }>;
      };
      return Promise.all(
        (list.messages ?? []).map(async ({ id }) => {
          const message = (await request(
            `${gmail}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          )) as {
            id: string;
            threadId: string;
            snippet: string;
            payload?: { headers?: Array<{ name: string; value: string }> };
          };
          return {
            id: message.id,
            threadId: message.threadId,
            from: header(message.payload?.headers, "From"),
            subject: header(message.payload?.headers, "Subject"),
            date: header(message.payload?.headers, "Date"),
            snippet: message.snippet,
          };
        }),
      );
    },
    gmail_read: async (args) => {
      const message = (await request(
        `${gmail}/messages/${encodeURIComponent(required(args, "messageId"))}?format=full`,
      )) as {
        id: string;
        threadId: string;
        payload: GmailPart & { headers?: Array<{ name: string; value: string }> };
      };
      const headers = message.payload.headers;
      return {
        id: message.id,
        threadId: message.threadId,
        from: header(headers, "From"),
        to: header(headers, "To"),
        cc: header(headers, "Cc"),
        subject: header(headers, "Subject"),
        date: header(headers, "Date"),
        text: truncate(messageText(message.payload)),
      };
    },
    gmail_draft: async (args) => {
      const threadId = argString(args, "threadId");
      const raw = buildRawMessage({
        to: argList(args, "to"),
        cc: argList(args, "cc"),
        subject: required(args, "subject"),
        body: required(args, "body"),
      });
      const draft = (await request(`${gmail}/drafts`, {
        method: "POST",
        body: { message: { raw, ...(threadId ? { threadId } : {}) } },
      })) as { id: string; message: { id: string } };
      return { draftId: draft.id, messageId: draft.message.id };
    },
    gmail_send: async (args) => {
      const threadId = argString(args, "threadId");
      const raw = buildRawMessage({
        to: argList(args, "to"),
        cc: argList(args, "cc"),
        subject: required(args, "subject"),
        body: required(args, "body"),
      });
      const sent = (await request(`${gmail}/messages/send`, {
        method: "POST",
        body: { raw, ...(threadId ? { threadId } : {}) },
      })) as { id: string; threadId: string };
      return { messageId: sent.id, threadId: sent.threadId };
    },
    calendar_list_events: async (args) => {
      const query = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(argLimit(args)),
        timeMin: argString(args, "timeMin") ?? new Date().toISOString(),
      });
      const timeMax = argString(args, "timeMax");
      if (timeMax) query.set("timeMax", timeMax);
      const q = argString(args, "query");
      if (q) query.set("q", q);
      const events = (await request(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`,
      )) as { items?: ReadonlyArray<Record<string, unknown>> };
      return (events.items ?? []).map((event) => ({
        id: event.id,
        summary: event.summary,
        start: event.start,
        end: event.end,
        location: event.location,
        attendees: (event.attendees as Array<{ email: string }> | undefined)?.map((a) => a.email),
        link: event.htmlLink,
      }));
    },
    calendar_create_event: async (args) => {
      const attendees = argList(args, "attendees");
      const event = (await request(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${attendees.length > 0 ? "all" : "none"}`,
        {
          method: "POST",
          body: {
            summary: required(args, "summary"),
            start: eventTime(required(args, "start")),
            end: eventTime(required(args, "end")),
            description: argString(args, "description"),
            location: argString(args, "location"),
            attendees: attendees.map((email) => ({ email })),
          },
        },
      )) as { id: string; htmlLink: string };
      return { eventId: event.id, link: event.htmlLink };
    },
    drive_search: async (args) => {
      const words = (argString(args, "query") ?? "").replace(/['\\]/g, " ").trim();
      const query = new URLSearchParams({
        pageSize: String(argLimit(args)),
        orderBy: "modifiedTime desc",
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        q: words
          ? `trashed = false and (name contains '${words}' or fullText contains '${words}')`
          : "trashed = false",
      });
      const result = (await request(`https://www.googleapis.com/drive/v3/files?${query}`)) as {
        files?: ReadonlyArray<unknown>;
      };
      return result.files ?? [];
    },
    drive_read: async (args) => {
      const fileId = encodeURIComponent(required(args, "fileId"));
      const file = (await request(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink`,
      )) as { id: string; name: string; mimeType: string; webViewLink: string };
      const exportAs: Record<string, string> = {
        "application/vnd.google-apps.document": "text/plain",
        "application/vnd.google-apps.spreadsheet": "text/csv",
        "application/vnd.google-apps.presentation": "text/plain",
      };
      const exportType = exportAs[file.mimeType];
      const readable =
        exportType !== undefined ||
        file.mimeType.startsWith("text/") ||
        file.mimeType === "application/json";
      if (!readable)
        return { ...file, text: null, note: "Not a text file; open it from the link." };
      const text = (await request(
        exportType === undefined
          ? `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
          : `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(exportType)}`,
        { raw: true },
      )) as string;
      return { ...file, text: truncate(text) };
    },
    docs_create: async (args) => {
      const doc = (await request("https://docs.googleapis.com/v1/documents", {
        method: "POST",
        body: { title: required(args, "title") },
      })) as { documentId: string };
      const text = argString(args, "text");
      if (text) {
        await request(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
          method: "POST",
          body: { requests: [{ insertText: { location: { index: 1 }, text } }] },
        });
      }
      return {
        documentId: doc.documentId,
        link: `https://docs.google.com/document/d/${doc.documentId}/edit`,
      };
    },
    contacts_search: async (args) => {
      const query = new URLSearchParams({
        query: required(args, "query"),
        pageSize: String(argLimit(args)),
        readMask: "names,emailAddresses,phoneNumbers,organizations",
      });
      const result = (await request(
        `https://people.googleapis.com/v1/people:searchContacts?${query}`,
      )) as {
        results?: ReadonlyArray<{
          person: {
            names?: Array<{ displayName: string }>;
            emailAddresses?: Array<{ value: string }>;
            phoneNumbers?: Array<{ value: string }>;
            organizations?: Array<{ name?: string; title?: string }>;
          };
        }>;
      };
      return (result.results ?? []).map(({ person }) => ({
        name: person.names?.[0]?.displayName,
        emails: person.emailAddresses?.map((entry) => entry.value) ?? [],
        phones: person.phoneNumbers?.map((entry) => entry.value) ?? [],
        organization: person.organizations?.[0]?.name,
        title: person.organizations?.[0]?.title,
      }));
    },
  };

  return {
    listTools: async () => GOOGLE_TOOLS,
    callTool: async (name, args) => {
      const handler = handlers[name];
      if (handler === undefined) throw new Error(`Google has no tool named ${name}.`);
      try {
        const result = await handler(args);
        return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
      } catch (error) {
        // Lost access goes up so the connector shows Not working; a 403 on one file stays a result.
        if (typeof error === "object" && error !== null && "code" in error) {
          if ((error as { code: unknown }).code === 401) throw error;
        }
        if (error instanceof Error && error.name === "GoogleAuthError") throw error;
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
    close: async () => undefined,
  };
};

/** The signed-in account's address, read with a fresh access token. */
export const googleAccountEmail = async (broker: GoogleBroker, accessToken: string) => {
  const response = await broker.fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google returned ${response.status} for the account.`);
  return ((await response.json()) as { emailAddress: string }).emailAddress;
};
