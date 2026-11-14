import { describe, expect, it } from "@effect/vitest";

import { authoredText } from "./messageAuthor.ts";

describe("authoredText", () => {
  it("names a teammate for the agent, and leaves the owner's words and slash commands alone", () => {
    const sam = { memberId: "sam", name: "Sam" };
    expect(authoredText({ text: "Ship it", author: sam })).toBe(
      "Message from teammate Sam:\n\nShip it",
    );
    expect(authoredText({ text: "Ship it" })).toBe("Ship it");
    expect(authoredText({ text: "/compact", author: sam })).toBe("/compact");
  });
});
