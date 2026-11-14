import { describe, expect, it } from "@effect/vitest";

import { buildRawMessage, messageText } from "./googleTools.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("buildRawMessage", () => {
  it("encodes a non-ASCII subject and keeps the body as UTF-8", () => {
    const raw = Buffer.from(
      buildRawMessage({
        to: ["a@x.test"],
        cc: ["b@x.test"],
        subject: "Café plan",
        body: "Hola 👋",
      }),
      "base64url",
    ).toString("utf8");
    expect(raw).toBe(
      [
        "To: a@x.test",
        "Cc: b@x.test",
        `Subject: =?UTF-8?B?${Buffer.from("Café plan").toString("base64")}?=`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "Hola 👋",
      ].join("\r\n"),
    );
  });
});

describe("messageText", () => {
  it.each([
    [
      "plain text wins over HTML",
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64("<p>Hi</p>") } },
          { mimeType: "text/plain", body: { data: b64("Hi there") } },
        ],
      },
      "Hi there",
    ],
    [
      "HTML-only mail loses its tags",
      {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/html",
                body: { data: b64("<style>p{}</style><p>Q3 &amp; Q4</p><br>Thanks") },
              },
            ],
          },
        ],
      },
      "Q3 & Q4\n\nThanks",
    ],
    ["no body at all", { mimeType: "multipart/mixed", parts: [] }, ""],
  ])("%s", (_name, payload, expected) => {
    expect(messageText(payload)).toBe(expected);
  });
});
