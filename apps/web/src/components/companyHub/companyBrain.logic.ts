import type {
  CompanyBrainCollection,
  CompanyBrainFailure,
  CompanyBrainFields,
  CompanyBrainRecordSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

/** What a founder tracks first. Each is a folder with a README the agents read. */
export const STARTER_COLLECTIONS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly stages: ReadonlyArray<string>;
}> = [
  {
    id: "people",
    label: "People",
    description:
      "Everyone we know: customers, investors, advisors, candidates. One file per person, with email, company, and how we know them.",
    stages: [],
  },
  {
    id: "companies",
    label: "Companies",
    description:
      "Customers, prospects, partners, and competitors. One file per company, with website, size, and who we know there.",
    stages: [],
  },
  {
    id: "deals",
    label: "Deals",
    description:
      "Our sales pipeline. One file per deal, with the company, contact, value, and next step.",
    stages: ["lead", "contacted", "meeting", "proposal", "won", "lost"],
  },
  {
    id: "fundraising",
    label: "Fundraising",
    description:
      "Investors we are raising from. One file per investor or fund, with partner, check size, and next step.",
    stages: ["target", "intro", "meeting", "diligence", "committed", "passed"],
  },
  {
    id: "hiring",
    label: "Hiring",
    description:
      "Candidates for open roles. One file per candidate, with role, source, and next step.",
    stages: ["sourced", "screen", "interview", "offer", "hired", "declined"],
  },
];

export const NO_STAGE = "No stage";

/** Board columns in the collection's order; values it does not list get their own columns after. */
export function groupByStage(
  collection: Pick<CompanyBrainCollection, "stageField" | "stages">,
  records: ReadonlyArray<CompanyBrainRecordSummary>,
) {
  const columns = new Map<string, Array<CompanyBrainRecordSummary>>(
    collection.stages.map((stage) => [stage, []]),
  );
  const keyOf = (stage: string) =>
    collection.stages.find((known) => known.toLowerCase() === stage.toLowerCase()) ?? stage;
  for (const record of records) {
    const value = record.fields[collection.stageField];
    const stage = typeof value === "string" && value.trim() !== "" ? keyOf(value.trim()) : NO_STAGE;
    const column = columns.get(stage) ?? [];
    column.push(record);
    columns.set(stage, column);
  }
  const noStage = columns.get(NO_STAGE);
  columns.delete(NO_STAGE);
  return [
    ...[...columns].map(([stage, items]) => ({ stage, records: items })),
    ...(noStage && noStage.length > 0 ? [{ stage: NO_STAGE, records: noStage }] : []),
  ];
}

const TITLE_FIELDS = new Set(["name", "title"]);
const TABLE_COLUMN_LIMIT = 4;

export const tableColumns = (fields: ReadonlyArray<string>) =>
  fields.filter((field) => !TITLE_FIELDS.has(field)).slice(0, TABLE_COLUMN_LIMIT);

export function formatFieldValue(value: CompanyBrainFields[string] | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(", ");
  }
  return JSON.stringify(value);
}

export interface FieldRow {
  readonly key: string;
  readonly value: string;
}

/** Strings edit as typed; other values edit as JSON so numbers and lists keep their type. */
export const fieldRowsOf = (fields: CompanyBrainFields): ReadonlyArray<FieldRow> =>
  Object.entries(fields)
    .filter(([key]) => !TITLE_FIELDS.has(key))
    .map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));

/** Only what changed, so fields nobody touched stay as written in the file. */
export function fieldChanges(original: CompanyBrainFields, rows: ReadonlyArray<FieldRow>) {
  const set: Record<string, CompanyBrainFields[string]> = {};
  const kept = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "" || TITLE_FIELDS.has(key)) continue;
    kept.add(key);
    const before = original[key];
    let value: CompanyBrainFields[string] = row.value;
    if (before !== undefined && typeof before !== "string") {
      try {
        value = JSON.parse(row.value) as CompanyBrainFields[string];
      } catch {
        value = row.value;
      }
    }
    if (JSON.stringify(value) !== JSON.stringify(before)) set[key] = value;
  }
  const unset = Object.keys(original).filter((key) => !TITLE_FIELDS.has(key) && !kept.has(key));
  return { set, unset };
}

export function brainFailure(cause: Cause.Cause<unknown>): {
  readonly reason: CompanyBrainFailure | null;
  readonly message: string;
} {
  const error = Cause.squash(cause);
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "CompanyBrainError" &&
    "reason" in error &&
    "message" in error
  ) {
    return { reason: error.reason as CompanyBrainFailure, message: String(error.message) };
  }
  return { reason: null, message: error instanceof Error ? error.message : String(error) };
}
