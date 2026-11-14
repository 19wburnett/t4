import {
  CompanyBrainCollectionId,
  CompanyBrainRecordId,
  type CompanyBrainFields,
  type CompanyBrainRecordSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BRIDGE_AGENTS } from "./companyHub.logic";
import {
  buildEmployeePrompt,
  EMPLOYEE_TEMPLATES,
  type Employee,
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

describe("buildEmployeePrompt", () => {
  const employee: Employee = {
    recordId: CompanyBrainRecordId.make("sam"),
    name: "Sam",
    role: "SDR",
    provider: "muse",
    providerLabel: "Muse",
  };

  it("leads with the role, then the instructions, the work, and where to look", () => {
    const prompt = buildEmployeePrompt(
      employee,
      "# Instructions\n\nFind good leads.",
      "  Draft a sequence.  ",
    );
    expect(prompt).toBe(
      [
        "You are Sam, our SDR.",
        "# Instructions\n\nFind good leads.",
        "Draft a sequence.",
        "Read company/BRAIN.md and the records in company/ before you start, and save what you learn with t3_brain_save. Ask me before sending or publishing anything.",
      ].join("\n\n"),
    );
  });

  it("skips the name when the employee is still named after the role", () => {
    expect(buildEmployeePrompt({ ...employee, name: "SDR" }, "", "")).toBe(
      [
        "You are our SDR.",
        "Read company/BRAIN.md and the records in company/ before you start, and save what you learn with t3_brain_save. Ask me before sending or publishing anything.",
      ].join("\n\n"),
    );
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
