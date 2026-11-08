import type {
  CompanyBrainFields,
  CompanyBrainRecordId,
  CompanyBrainRecordSummary,
} from "@t3tools/contracts";

import { BRIDGE_AGENTS, COMPANY_DIR, type WorkTaskTarget } from "./companyHub.logic";

/** An employee is a record in the brain, so agents and people share one place for the team. */
export const TEAM_COLLECTION = "agents";

export const TEAM_COLLECTION_LABEL = "Team";

const EMPLOYEE_PROVIDERS = ["muse", "grok", "claude", "codex"] as const;

export type EmployeeProvider = (typeof EMPLOYEE_PROVIDERS)[number];

export const EMPLOYEE_PROVIDER_LABELS: Record<EmployeeProvider, string> = {
  muse: "Muse",
  grok: "Grok Bot",
  claude: "Claude",
  codex: "Codex",
};

/** Where this kind of employee runs. The role lives in the record; the runtime is a setting. */
export function employeeTargetOf(provider: EmployeeProvider): WorkTaskTarget {
  if (provider === "claude" || provider === "codex") return { kind: "coding", provider };
  const instanceId = provider === "muse" ? "museBot" : "grokBot";
  const agent = BRIDGE_AGENTS.find((entry) => entry.instanceId === instanceId) ?? BRIDGE_AGENTS[0];
  return { kind: "bridge", agent };
}

export interface EmployeeTemplate {
  readonly id: string;
  /** The employee's name until you rename them. */
  readonly role: string;
  readonly provider: EmployeeProvider;
  readonly summary: string;
  /** Brain collections the employee works with. */
  readonly collections: ReadonlyArray<string>;
  /** Where the employee sends and publishes. */
  readonly channels: ReadonlyArray<string>;
  readonly instructions: string;
}

export const EMPLOYEE_TEMPLATES: ReadonlyArray<EmployeeTemplate> = [
  {
    id: "sdr",
    role: "SDR",
    provider: "muse",
    summary: "Finds leads, writes sequences, and follows up",
    collections: ["people", "companies", "deals"],
    channels: ["email", "social"],
    instructions:
      "You find companies and people that match our ideal customer profile and keep them in the people, companies, and deals collections. You write short, specific outreach in our voice, log every touch on the person's record, and follow up when a deal goes quiet. You never send anything without my approval.",
  },
  {
    id: "social",
    role: "Social manager",
    provider: "grok",
    summary: "Plans and drafts posts for every channel",
    collections: ["people", "companies"],
    channels: ["social"],
    instructions:
      "You plan our social calendar and draft posts for X, LinkedIn, and Threads in our voice. You turn product news, customer stories, and things we learned into posts people want to read. You put each draft in the outbox and never publish without my approval.",
  },
  {
    id: "support",
    role: "Support",
    provider: "muse",
    summary: "Answers customers and flags product issues",
    collections: ["people", "companies"],
    channels: ["email"],
    instructions:
      "You answer customer questions from the inbox, using the brain for how the product works and what we have promised. You log each conversation on the person's record, and when a request is really a product or code problem you say so instead of promising a fix. You never send a reply without my approval.",
  },
  {
    id: "recruiter",
    role: "Recruiter",
    provider: "muse",
    summary: "Sources candidates and keeps hiring moving",
    collections: ["hiring", "people"],
    channels: ["email"],
    instructions:
      "You keep the hiring collection current: source candidates, write outreach and interview invites, and move each one along its stage. You prepare a short brief before every interview with what to probe. You never send anything without my approval.",
  },
  {
    id: "chief-of-staff",
    role: "Chief of staff",
    provider: "muse",
    summary: "Keeps priorities, follow-ups, and briefs moving",
    collections: ["people", "companies", "deals", "fundraising", "hiring"],
    channels: ["email"],
    instructions:
      "You keep the company moving. Each morning you summarize what needs me, which deals and fundraising conversations have gone quiet, and what to do about them. Before a meeting you write a one-page brief from that person's record. You keep records current as things change.",
  },
  {
    id: "bookkeeper",
    role: "Bookkeeper",
    provider: "claude",
    summary: "Keeps the books tidy and flags what needs you",
    collections: ["companies", "deals"],
    channels: ["email"],
    instructions:
      "You keep track of money coming in and going out: invoices, subscriptions, and anything that looks off. You record what you find in the brain, flag unusual charges and late payments, and prepare what an accountant needs at the end of the month. You never move money.",
  },
  {
    id: "designer",
    role: "Designer",
    provider: "claude",
    summary: "Makes pages, decks, and graphics on brand",
    collections: ["companies"],
    channels: [],
    instructions:
      "You design what the company needs: landing pages, decks, one-pagers, and social graphics. You follow company/DESIGN.md and the skills this machine has for design, and you keep the source files with the work so anyone can change them later. You show me options before you ship anything.",
  },
  {
    id: "engineer",
    role: "Engineer",
    provider: "claude",
    summary: "Ships product changes and fixes",
    collections: ["companies", "deals"],
    channels: [],
    instructions:
      "You build the product. You take a request from me or from support, make the smallest correct change, and prove it works before you call it done. You keep the company brain current when the product changes in a way our customers would notice.",
  },
];

export interface Employee {
  readonly recordId: CompanyBrainRecordId;
  readonly name: string;
  readonly role: string;
  readonly provider: EmployeeProvider;
  readonly providerLabel: string;
}

const textField = (fields: CompanyBrainFields, key: string): string => {
  const value = fields[key];
  return typeof value === "string" ? value.trim() : "";
};

const listField = (fields: CompanyBrainFields, key: string): ReadonlyArray<string> => {
  const value = fields[key];
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry.trim() !== "" ? [entry] : []))
    : [];
};

export function employeeFromRecord(record: CompanyBrainRecordSummary): Employee {
  const provider = EMPLOYEE_PROVIDERS.find(
    (candidate) => candidate === textField(record.fields, "provider").toLowerCase(),
  );
  const role = textField(record.fields, "role") || record.title;
  return {
    recordId: record.id,
    name: record.title,
    role,
    // A record without a provider still shows; Muse is the general work agent.
    provider: provider ?? "muse",
    providerLabel: EMPLOYEE_PROVIDER_LABELS[provider ?? "muse"],
  };
}

export const employeeFields = (template: EmployeeTemplate): CompanyBrainFields => ({
  kind: "employee",
  role: template.role,
  provider: template.provider,
  collections: [...template.collections],
  channels: [...template.channels],
});

export const employeeBody = (template: EmployeeTemplate): string =>
  `# Instructions\n\n${template.instructions}\n`;

/** The thread opens with the employee's role, then the work; the brain is read from the project. */
export function buildEmployeePrompt(
  employee: Pick<Employee, "name" | "role">,
  instructions: string,
  task: string,
): string {
  const role =
    employee.name === employee.role
      ? `You are our ${employee.role}.`
      : `You are ${employee.name}, our ${employee.role}.`;
  const instructionsText = instructions.trim();
  const taskText = task.trim();
  return [
    role,
    instructionsText,
    taskText,
    `Read ${COMPANY_DIR}/BRAIN.md and the records in ${COMPANY_DIR}/ before you start, and save what you learn with t3_brain_save. Ask me before sending or publishing anything.`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function employeeCollections(record: CompanyBrainRecordSummary): ReadonlyArray<string> {
  return listField(record.fields, "collections");
}
