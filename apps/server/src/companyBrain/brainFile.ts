import { CompanyBrainRecordId, type CompanyBrainFields } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isMap, parseDocument, type Document } from "yaml";

export const BRAIN_DIR = "company";
/** Folders in `company/` that hold something other than records. */
const RESERVED_FOLDERS = new Set(["outbox"]);
export const COLLECTION_README = "README.md";
const LOG_HEADING = "## Log";

export const isCollectionFolder = (name: string) =>
  !name.startsWith(".") && !RESERVED_FOLDERS.has(name.toLowerCase());

const decodeRecordId = Schema.decodeOption(CompanyBrainRecordId);

export const recordIdFromFileName = (name: string) => {
  if (!name.endsWith(".md") || name === COLLECTION_README) return null;
  const decoded = decodeRecordId(name.slice(0, -3));
  return decoded._tag === "Some" ? decoded.value : null;
};

const isJson = Schema.is(Schema.Json);

type Split =
  | { readonly _tag: "Split"; readonly frontmatter: string | null; readonly body: string }
  | { readonly _tag: "Malformed"; readonly message: string };

/** A file without a leading `---` block is all body, like most notes in a vault. */
function split(contents: string): Split {
  const text = contents.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { _tag: "Split", frontmatter: null, body: text };
  const end = text.indexOf("\n---", 3);
  const afterEnd = end === -1 ? -1 : end + 4;
  if (end === -1 || (afterEnd < text.length && text[afterEnd] !== "\n")) {
    return { _tag: "Malformed", message: "The frontmatter block has no closing ---." };
  }
  return {
    _tag: "Split",
    frontmatter: text.slice(4, end + 1),
    body: text.slice(Math.min(afterEnd + 1, text.length)),
  };
}

type ParsedDocument =
  | { readonly _tag: "Document"; readonly document: Document; readonly body: string }
  | { readonly _tag: "Malformed"; readonly message: string };

function parse(contents: string): ParsedDocument {
  const parts = split(contents);
  if (parts._tag === "Malformed") return parts;
  const document = parseDocument(parts.frontmatter ?? "");
  if (document.errors.length > 0) {
    return { _tag: "Malformed", message: "The frontmatter is not valid YAML." };
  }
  if (document.contents !== null && !isMap(document.contents)) {
    return { _tag: "Malformed", message: "The frontmatter is not a list of fields." };
  }
  return { _tag: "Document", document, body: parts.body };
}

export type ParsedRecord =
  | { readonly _tag: "Record"; readonly fields: CompanyBrainFields; readonly body: string }
  | { readonly _tag: "Malformed"; readonly message: string };

export function parseRecord(contents: string): ParsedRecord {
  const parsed = parse(contents);
  if (parsed._tag === "Malformed") return parsed;
  const fields: unknown = parsed.document.toJS() ?? {};
  if (!isJson(fields)) {
    return { _tag: "Malformed", message: "A field has a value that is not plain text or numbers." };
  }
  return { _tag: "Record", fields: fields as CompanyBrainFields, body: parsed.body };
}

export interface RecordChange {
  readonly set?: CompanyBrainFields;
  readonly unset?: ReadonlyArray<string>;
  readonly body?: string;
  /** Already dated and signed. */
  readonly logEntry?: string;
}

/** Edits through the YAML document, so the user's comments and field order survive. */
export function updateRecord(
  contents: string | null,
  change: RecordChange,
): ParsedRecord & {
  readonly contents?: string;
} {
  const parsed = parse(contents ?? "");
  if (parsed._tag === "Malformed") return parsed;
  const { document } = parsed;
  for (const key of change.unset ?? []) document.delete(key);
  for (const [key, value] of Object.entries(change.set ?? {})) document.set(key, value);
  let body = change.body ?? parsed.body;
  if (change.logEntry !== undefined) body = addLogEntry(body, change.logEntry);
  const yaml = document.contents === null ? "" : document.toString({ lineWidth: 0 });
  const text = yaml.trim() === "" ? body : `---\n${yaml}---\n${body}`;
  const reparsed = parseRecord(text);
  return reparsed._tag === "Record" ? { ...reparsed, contents: text } : reparsed;
}

/** Newest first, under a `## Log` heading that is added at the end when missing. */
export function addLogEntry(body: string, entry: string): string {
  const line = `- ${entry.replace(/\s*\n\s*/g, " ")}`;
  const lines = body.split("\n");
  const heading = lines.findIndex((text) => text.trim() === LOG_HEADING);
  if (heading === -1) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}${trimmed === "" ? "" : "\n\n"}${LOG_HEADING}\n\n${line}\n`;
  }
  const insertAt = lines[heading + 1]?.trim() === "" ? heading + 2 : heading + 1;
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)].join("\n");
}

export function recordTitle(id: string, fields: CompanyBrainFields): string {
  for (const key of ["name", "title"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return id;
}

/** New records get readable lowercase file names; existing files keep theirs. */
export function slugify(title: string): string {
  return (
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "record"
  );
}

export interface CollectionConfig {
  readonly label: string | null;
  readonly stageField: string;
  readonly stages: ReadonlyArray<string>;
  readonly description: string;
}

const README_DESCRIPTION_MAX_CHARS = 2_000;

/** A missing or unreadable README leaves the collection a plain list named after its folder. */
export function parseCollectionReadme(contents: string | null): CollectionConfig {
  const parsed = contents === null ? null : parseRecord(contents);
  const fields = parsed?._tag === "Record" ? parsed.fields : {};
  const stages = Array.isArray(fields.stages)
    ? fields.stages.flatMap((stage) =>
        typeof stage === "string" && stage.trim() !== "" ? [stage.trim()] : [],
      )
    : [];
  return {
    label: typeof fields.label === "string" && fields.label.trim() !== "" ? fields.label : null,
    stageField:
      typeof fields.stageField === "string" && fields.stageField.trim() !== ""
        ? fields.stageField
        : "stage",
    stages,
    description:
      parsed?._tag === "Record" ? parsed.body.trim().slice(0, README_DESCRIPTION_MAX_CHARS) : "",
  };
}

export function updateCollectionReadme(
  contents: string | null,
  change: {
    readonly label?: string;
    readonly description?: string;
    readonly stages?: ReadonlyArray<string>;
  },
) {
  return updateRecord(contents, {
    set: {
      ...(change.label === undefined ? {} : { label: change.label }),
      ...(change.stages === undefined ? {} : { stages: [...change.stages] }),
    },
    ...(change.description === undefined
      ? {}
      : { body: change.description.trim() === "" ? "" : `${change.description.trim()}\n` }),
  });
}

/** Field names in the order a table shows them: most used first, ties by first appearance. */
export function fieldNamesByUse(records: ReadonlyArray<{ readonly fields: CompanyBrainFields }>) {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const key of Object.keys(record.fields)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1]).map(([key]) => key);
}
