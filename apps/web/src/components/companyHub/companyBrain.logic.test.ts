import {
  CompanyBrainCollectionId,
  CompanyBrainRecordId,
  type CompanyBrainFields,
  type CompanyBrainRecordSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeBrainSource,
  fieldChanges,
  fieldRowsOf,
  groupByStage,
  NO_STAGE,
} from "./companyBrain.logic";

const record = (id: string, fields: CompanyBrainFields): CompanyBrainRecordSummary => ({
  collection: CompanyBrainCollectionId.make("deals"),
  id: CompanyBrainRecordId.make(id),
  path: `company/deals/${id}.md`,
  title: id,
  fields,
  updatedAt: null,
});

describe("groupByStage", () => {
  it("keeps the collection's stage order, matches case, and adds unknown and missing stages after", () => {
    const columns = groupByStage({ stageField: "stage", stages: ["lead", "won"] }, [
      record("a", { stage: "Won" }),
      record("b", {}),
      record("c", { stage: "paused" }),
      record("d", { stage: "lead" }),
    ]);
    expect(columns.map((column) => [column.stage, column.records.map((r) => r.id)])).toEqual([
      ["lead", ["d"]],
      ["won", ["a"]],
      ["paused", ["c"]],
      [NO_STAGE, ["b"]],
    ]);
  });
});

describe("fieldChanges", () => {
  it("sends only edited fields, keeps value types, and unsets removed rows", () => {
    const original = { name: "Acme", stage: "lead", value: 12000, tags: ["ai"], owner: "Sam" };
    const rows = fieldRowsOf(original).flatMap((row) =>
      row.key === "owner" ? [] : [row.key === "value" ? { ...row, value: "15000" } : row],
    );
    expect(fieldChanges(original, [...rows, { key: "email", value: "a@acme.com" }])).toEqual({
      set: { value: 15000, email: "a@acme.com" },
      unset: ["owner"],
    });
  });
});

describe("describeBrainSource", () => {
  it.each([
    [{ _tag: "local" } as const, "Only on this machine"],
    [
      {
        _tag: "git",
        remoteUrl: "git@github.com:acme/brain.git",
        branch: "main",
        changes: 1,
        ahead: 2,
        behind: 0,
      } as const,
      "acme/brain · 1 change here · 2 to push",
    ],
    [
      {
        _tag: "git",
        remoteUrl: "https://gitlab.com/acme/brain.git",
        branch: null,
        changes: 0,
        ahead: 0,
        behind: 0,
      } as const,
      "https://gitlab.com/acme/brain · up to date",
    ],
  ])("labels %j", (source, label) => {
    expect(describeBrainSource(source)).toBe(label);
  });
});
