import type { ScheduledTaskSchedule } from "@t3tools/contracts";

export interface CompanyRoutinePreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly title: string;
  /** Fixed-time so the work lands before the day starts. */
  readonly timeOfDay: string;
  /** 0 is Sunday. Omitted runs every day. */
  readonly weekdays?: ReadonlyArray<number>;
  readonly prompt: string;
}

/** Recurring founder work, created as ordinary scheduled tasks so one scheduler runs everything. */
export const COMPANY_ROUTINE_PRESETS: ReadonlyArray<CompanyRoutinePreset> = [
  {
    id: "morning-triage",
    label: "Morning triage",
    description: "Inbox, follow-ups, and what needs you today",
    title: "Morning triage",
    timeOfDay: "08:00",
    weekdays: [1, 2, 3, 4, 5],
    prompt:
      "Triage the inbox for the accounts in company/CHANNELS.md and review the brain for anything waiting on us. Group what needs me, draft replies in our voice, and leave everything for my approval. Flag anything urgent or unanswered for more than a day.",
  },
  {
    id: "pipeline",
    label: "Follow up on pipeline",
    description: "Nudge deals and candidates that went quiet",
    title: "Follow up on pipeline",
    timeOfDay: "09:00",
    weekdays: [1],
    prompt:
      "Review the deals, fundraising, and hiring collections. For each record whose next step is in the past, draft the follow-up and log it on the record with t3_brain_save. Give me a short list of what you did and what needs my decision.",
  },
  {
    id: "metrics",
    label: "Weekly metrics",
    description: "Write this week's numbers to the brain",
    title: "Weekly metrics",
    timeOfDay: "08:00",
    weekdays: [1],
    prompt:
      "Pull this week's revenue, signups, and runway from Stripe and our analytics through the browser, then write company/METRICS.md with the numbers, the trend, and what changed since last week.",
  },
  {
    id: "investor-update",
    label: "Investor update",
    description: "Draft the update from the week's numbers",
    title: "Investor update",
    timeOfDay: "15:00",
    weekdays: [5],
    prompt:
      "Draft this week's investor update from the numbers, wins, and asks in company/. Save it as company/updates/<week>.md, keep it under one page, and leave it for my approval.",
  },
  {
    id: "social",
    label: "Social posts",
    description: "Draft next week's posts",
    title: "Social posts",
    timeOfDay: "10:00",
    weekdays: [4],
    prompt:
      "Draft next week's social posts for the channels in company/CHANNELS.md. Match our voice, give three options per post, and put them in the outbox for my approval.",
  },
  {
    id: "weekly-plan",
    label: "Weekly plan",
    description: "Three priorities and who owns what",
    title: "Weekly plan",
    timeOfDay: "07:30",
    weekdays: [1],
    prompt:
      "It's Monday. Summarize where the company is from the brain and this week's numbers, then propose the three priorities for the week and who should own each. Keep it to one page.",
  },
];

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function routineScheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Every day"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day] ?? day).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}
