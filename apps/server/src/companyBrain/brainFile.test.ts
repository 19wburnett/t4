import { describe, expect, it } from "@effect/vitest";

import {
  addLogEntry,
  parseCollectionReadme,
  parseRecord,
  recordIdFromFileName,
  updateRecord,
} from "./brainFile.ts";

describe("brain record files", () => {
  it("edits fields in place, keeping comments, order and dates as written", () => {
    const original = [
      "---",
      "# from the CRM export",
      "name: Ada Lovelace # founder",
      "stage: intro",
      "met: 2026-01-02",
      "---",
      "Met at the demo day.",
      "",
    ].join("\n");
    const updated = updateRecord(original, {
      set: { stage: "meeting", tags: ["seed", "ai"] },
      unset: ["met"],
    });
    expect(updated.contents).toBe(
      [
        "---",
        "# from the CRM export",
        "name: Ada Lovelace # founder",
        "stage: meeting",
        "tags:",
        "  - seed",
        "  - ai",
        "---",
        "Met at the demo day.",
        "",
      ].join("\n"),
    );
    expect(parseRecord(original)).toMatchObject({ fields: { met: "2026-01-02" } });
  });

  it("reads a note with no frontmatter as a record with no fields, and adds fields to it", () => {
    expect(parseRecord("# Pricing\n\nWe charge per seat.\n")).toEqual({
      _tag: "Record",
      fields: {},
      body: "# Pricing\n\nWe charge per seat.\n",
    });
    expect(updateRecord("# Pricing\n", { set: { owner: "Sam" } }).contents).toBe(
      "---\nowner: Sam\n---\n# Pricing\n",
    );
  });

  it.each([
    ["an unclosed block", "---\nname: x\n"],
    ["invalid YAML", "---\nname: [x\n---\n"],
    ["a list instead of fields", "---\n- a\n---\n"],
  ])("reports %s as malformed and refuses to edit it", (_name, text) => {
    expect(parseRecord(text)._tag).toBe("Malformed");
    expect(updateRecord(text, { set: { stage: "won" } })._tag).toBe("Malformed");
  });

  it("logs newest first under one Log heading", () => {
    const once = addLogEntry("Notes.\n", "2026-11-07 Claude: Sent the deck");
    expect(once).toBe("Notes.\n\n## Log\n\n- 2026-11-07 Claude: Sent the deck\n");
    expect(addLogEntry(once, "2026-11-08 You: Call booked\nfor Tue")).toBe(
      "Notes.\n\n## Log\n\n- 2026-11-08 You: Call booked for Tue\n- 2026-11-07 Claude: Sent the deck\n",
    );
  });

  it("only takes Markdown files with safe names as records", () => {
    expect(recordIdFromFileName("Ada Lovelace.md")).toBe("Ada Lovelace");
    expect(recordIdFromFileName("README.md")).toBeNull();
    expect(recordIdFromFileName(".hidden.md")).toBeNull();
    expect(recordIdFromFileName("notes.txt")).toBeNull();
  });

  it("configures a collection from its README", () => {
    expect(
      parseCollectionReadme(
        "---\nlabel: Fundraising\nstages: [target, intro, '', committed]\n---\nInvestors we talk to.\n",
      ),
    ).toEqual({
      label: "Fundraising",
      stageField: "stage",
      stages: ["target", "intro", "committed"],
      description: "Investors we talk to.",
    });
    expect(parseCollectionReadme("---\nstages: [x\n---\n")).toMatchObject({ stages: [] });
  });
});
