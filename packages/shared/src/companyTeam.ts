/** Each AI employee (bot) is a record in this brain collection, `company/agents/`. */
export const TEAM_COLLECTION = "agents";

const EMPLOYEE_PROVIDERS = ["muse", "grok", "claude", "codex"] as const;

export type EmployeeProvider = (typeof EMPLOYEE_PROVIDERS)[number];

export const EMPLOYEE_PROVIDER_LABELS: Record<EmployeeProvider, string> = {
  muse: "Muse",
  grok: "Grok Bot",
  claude: "Claude",
  codex: "Codex",
};

/** A record without a known provider still works; Muse is the general work agent. */
export function employeeProviderOf(fields: Readonly<Record<string, unknown>>): EmployeeProvider {
  const value = fields.provider;
  const named = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMPLOYEE_PROVIDERS.find((provider) => provider === named) ?? "muse";
}

/** The thread opens with the employee's role, then the work; the brain is read from the project. */
export function buildEmployeePrompt(
  employee: { readonly name: string; readonly role: string },
  instructions: string,
  task: string,
): string {
  const role =
    employee.name === employee.role
      ? `You are our ${employee.role}.`
      : `You are ${employee.name}, our ${employee.role}.`;
  return [
    role,
    instructions.trim(),
    task.trim(),
    "Read company/BRAIN.md and the records in company/ before you start, and save what you learn with t3_brain_save. Ask me before sending or publishing anything. Message a teammate with t3_bot_message when their role fits the work better.",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}
