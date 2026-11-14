import {
  CompanyBrainCollectionId,
  CompanyBrainRecordId,
  type CompanyBrainFields,
  type CompanyBrainRecordSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BRIDGE_AGENTS } from "./companyHub.logic";
import {
  EMPLOYEE_TEMPLATES,
  employeeBody,
  employeeFields,
  employeeFromRecord,
  employeeTargetOf,
} from "./companyTeam.logic";

const record = (title: string, fields: CompanyBrainFields): CompanyBrainRecordSummary => ({
  collection: CompanyBrainCollectionId.make("agents"),
  id: CompanyBrainRecordId.make(title.toLowerCase()),
  path: `company/agents/${title.toLowerCase()}.md`,
  title,
  fields,
  updatedAt: null,
});

describe("employeeFromRecord", () => {
  it("reads the role and runtime, and names the provider", () => {
    expect(
      employeeFromRecord(record("Sam", { kind: "employee", role: "SDR", provider: "grok" })),
    ).toMatchObject({ name: "Sam", role: "SDR", provider: "grok", providerLabel: "Grok Bot" });
  });

  it("lists a hand-written agent with no provider on Muse", () => {
    expect(employeeFromRecord(record("Ada", { role: "Engineer" }))).toMatchObject({
      role: "Engineer",
      provider: "muse",
    });
  });
});

describe("employeeTargetOf", () => {
  it("sends bridge employees to their instance and coding employees to their provider", () => {
    expect(employeeTargetOf("muse")).toEqual({ kind: "bridge", agent: BRIDGE_AGENTS[0] });
    expect(employeeTargetOf("grok")).toEqual({ kind: "bridge", agent: BRIDGE_AGENTS[1] });
    expect(employeeTargetOf("claude")).toEqual({ kind: "coding", provider: "claude" });
    expect(employeeTargetOf("codex")).toEqual({ kind: "coding", provider: "codex" });
  });
});

describe("employee records", () => {
  it("every template is valid to save and shows up as an employee", () => {
    for (const template of EMPLOYEE_TEMPLATES) {
      const summary = record(template.role, employeeFields(template));
      expect(employeeFromRecord(summary)).toMatchObject({
        role: template.role,
        provider: template.provider,
      });
      expect(employeeBody(template)).toContain(template.instructions);
    }
  });
});
