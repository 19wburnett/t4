import { describe, expect, it } from "vite-plus/test";

import { COMPANY_ROUTINE_PRESETS, routineScheduleLabel } from "./companyRoutines.logic";

describe("routineScheduleLabel", () => {
  it.each([
    [{ type: "fixed_time", timeOfDay: "08:00" } as const, "Every day at 08:00"],
    [
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] } as const,
      "Weekdays at 09:00",
    ],
    [{ type: "fixed_time", timeOfDay: "10:00", weekdays: [1, 4] } as const, "Mon, Thu at 10:00"],
    [{ type: "interval", everyMs: 15 * 60_000 } as const, "Every 15 min"],
    [{ type: "webhook", signature: null } as const, "On webhook"],
  ])("labels %j", (schedule, label) => {
    expect(routineScheduleLabel(schedule)).toBe(label);
  });
});

describe("COMPANY_ROUTINE_PRESETS", () => {
  it("uses unique titles so a routine is not offered twice", () => {
    const titles = COMPANY_ROUTINE_PRESETS.map((preset) => preset.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
