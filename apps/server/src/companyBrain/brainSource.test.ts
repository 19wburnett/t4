import { describe, expect, it } from "@effect/vitest";

import { parseGitStatus, parseRepositoryInput, redactUrl } from "./brainSource.ts";

describe("brain source", () => {
  it.each([
    ["acme/brain", { _tag: "github", repository: "acme/brain" }],
    ["https://github.com/acme/brain.git", { _tag: "github", repository: "acme/brain" }],
    ["https://github.com/acme/brain/tree/main/crm", { _tag: "github", repository: "acme/brain" }],
    ["git@github.com:acme/brain.git", { _tag: "github", repository: "acme/brain" }],
    [
      "https://gitlab.com/acme/brain.git",
      { _tag: "url", url: "https://gitlab.com/acme/brain.git" },
    ],
    ["git@gitlab.com:acme/brain.git", { _tag: "url", url: "git@gitlab.com:acme/brain.git" }],
    ["acme brain", null],
    ["file:///srv/brain.git", { _tag: "url", url: "file:///srv/brain.git" }],
    ["mailto:a@b.c", null],
  ])("reads %s", (input, expected) => {
    expect(parseRepositoryInput(input)).toEqual(expected);
  });

  it("counts changes and ahead/behind from git status", () => {
    expect(
      parseGitStatus(
        [
          "# branch.oid abc",
          "# branch.head main",
          "# branch.upstream origin/main",
          "# branch.ab +2 -1",
          "1 .M N... 100644 100644 100644 a b deals/acme.md",
          "? people/ada.md",
          "",
        ].join("\n"),
      ),
    ).toEqual({ branch: "main", ahead: 2, behind: 1, changes: 2 });
    expect(parseGitStatus("# branch.head (detached)\n")).toEqual({
      branch: null,
      ahead: 0,
      behind: 0,
      changes: 0,
    });
  });

  it("strips credentials from URLs in messages", () => {
    expect(redactUrl("fatal: https://x-access-token:ghp_abc@github.com/acme/brain denied")).toBe(
      "fatal: https://github.com/acme/brain denied",
    );
  });
});
