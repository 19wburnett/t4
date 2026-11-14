import { describe, expect, it } from "vite-plus/test";

import { buildEmployeePrompt } from "./companyTeam.ts";

const closing =
  "Read company/BRAIN.md and the records in company/ before you start, and save what you learn with t3_brain_save. Ask me before sending or publishing anything. Message a teammate with t3_bot_message when their role fits the work better.";

describe("buildEmployeePrompt", () => {
  const employee = { name: "Sam", role: "SDR" };

  it("leads with the role, then the instructions, the work, and where to look", () => {
    expect(
      buildEmployeePrompt(employee, "# Instructions\n\nFind good leads.", "  Draft a sequence.  "),
    ).toBe(
      [
        "You are Sam, our SDR.",
        "# Instructions\n\nFind good leads.",
        "Draft a sequence.",
        closing,
      ].join("\n\n"),
    );
  });

  it("skips the name when the employee is still named after the role", () => {
    expect(buildEmployeePrompt({ ...employee, name: "SDR" }, "", "")).toBe(
      ["You are our SDR.", closing].join("\n\n"),
    );
  });
});
