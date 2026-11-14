import {
  type CompanyBrainCollection,
  CompanyBrainCollectionId,
  type CompanyBrainRecord,
  type CompanyBrainRecordId,
  type CompanyBrainRecordSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { companyBrainEnvironment } from "~/state/companyBrain";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  brainFailure,
  type FieldRow,
  fieldChanges,
  fieldRowsOf,
  formatFieldValue,
  groupByStage,
  NO_STAGE,
  STARTER_COLLECTIONS,
  tableColumns,
} from "./companyBrain.logic";

interface BrainTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

type Editing =
  | { readonly kind: "new"; readonly stage: string | null }
  | { readonly kind: "existing"; readonly recordId: CompanyBrainRecordId };

export function CompanyBrainRecordsSection(props: BrainTarget) {
  const listing = useAtomValue(
    companyBrainEnvironment.collections({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const canWrite = useAtomValue(
    companyBrainEnvironment.saveRecord.permissionAtom(props.environmentId),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [addingCustom, setAddingCustom] = useState(false);
  const saveCollection = useAtomCommand(companyBrainEnvironment.saveCollection, {
    label: "add collection",
  });

  const collections = AsyncResult.getOrElse(listing, () => null)?.collections ?? [];
  const active =
    collections.find((collection) => collection.id === selected) ?? collections[0] ?? null;
  const missingStarters = STARTER_COLLECTIONS.filter(
    (starter) => !collections.some((collection) => collection.id === starter.id),
  );

  const addCollection = async (input: {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly stages: ReadonlyArray<string>;
  }) => {
    const result = await saveCollection({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: CompanyBrainCollectionId.make(input.id),
        label: input.label,
        description: input.description,
        stages: [...input.stages],
      },
    });
    if (result._tag === "Success") setSelected(result.value.id);
    return result._tag === "Success";
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {collections.map((collection) => (
          <Button
            key={collection.id}
            size="xs"
            variant={collection.id === active?.id ? "secondary" : "ghost"}
            aria-pressed={collection.id === active?.id}
            onClick={() => setSelected(collection.id)}
          >
            {collection.label}
            <span className="tabular-nums text-muted-foreground">{collection.recordCount}</span>
          </Button>
        ))}
        <Menu>
          <MenuTrigger
            render={<Button size="xs" variant="ghost" className="ml-auto" disabled={!canWrite} />}
          >
            <PlusIcon aria-hidden />
            Collection
          </MenuTrigger>
          <MenuPopup align="end">
            {missingStarters.map((starter) => (
              <MenuItem key={starter.id} onClick={() => void addCollection(starter)}>
                {starter.label}
              </MenuItem>
            ))}
            {missingStarters.length > 0 ? <MenuSeparator /> : null}
            <MenuItem onClick={() => setAddingCustom(true)}>Other…</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {listing._tag === "Failure" ? (
        <p role="alert" className="text-sm text-destructive">
          {brainFailure(listing.cause).message}
        </p>
      ) : listing._tag === "Initial" ? null : active === null ? (
        <p className="text-sm text-muted-foreground">
          Keep people, deals, investors, and candidates here as files in company/, one folder per
          collection. Agents look them up and update them with t3_brain_find and t3_brain_save.
        </p>
      ) : (
        <CollectionView key={active.id} {...props} collection={active} canWrite={canWrite} />
      )}
      {addingCustom ? (
        <NewCollectionDialog
          onClose={() => setAddingCustom(false)}
          onCreate={async (input) => {
            if (await addCollection(input)) setAddingCustom(false);
          }}
        />
      ) : null}
    </div>
  );
}

function CollectionView(
  props: BrainTarget & { readonly collection: CompanyBrainCollection; readonly canWrite: boolean },
) {
  const listing = useAtomValue(
    companyBrainEnvironment.records({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, collection: props.collection.id },
    }),
  );
  const hasStages = props.collection.stages.length > 0;
  const [view, setView] = useState<"board" | "table">(hasStages ? "board" : "table");
  const [editing, setEditing] = useState<Editing | null>(null);
  const records = AsyncResult.getOrElse(listing, () => null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {props.collection.description ? (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {props.collection.description.split("\n")[0]}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        {hasStages ? (
          <ToggleGroup
            aria-label="Records view"
            value={[view]}
            onValueChange={(next) => {
              if (next[0] === "board" || next[0] === "table") setView(next[0]);
            }}
          >
            <Toggle value="board">Board</Toggle>
            <Toggle value="table">Table</Toggle>
          </ToggleGroup>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={!props.canWrite}
          onClick={() => setEditing({ kind: "new", stage: null })}
        >
          <PlusIcon aria-hidden />
          New
        </Button>
      </div>
      {listing._tag === "Failure" ? (
        <p role="alert" className="text-sm text-destructive">
          {brainFailure(listing.cause).message}
        </p>
      ) : records === null ? null : records.records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing in {props.collection.label} yet. Add one, or ask an agent to.
        </p>
      ) : view === "board" && hasStages ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {groupByStage(props.collection, records.records).map((column) => (
            <div
              key={column.stage}
              className="flex w-56 shrink-0 flex-col gap-1.5 rounded-xl border border-border/60 bg-muted/30 p-2"
            >
              <div className="flex items-center gap-1.5 px-1 text-xs font-medium">
                <span className="truncate capitalize">{column.stage}</span>
                <span className="tabular-nums text-muted-foreground">{column.records.length}</span>
              </div>
              {column.records.map((record) => (
                <RecordCard
                  key={record.id}
                  record={record}
                  fields={tableColumns(records.fields).filter(
                    (field) => field !== props.collection.stageField,
                  )}
                  onOpen={() => setEditing({ kind: "existing", recordId: record.id })}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <RecordTable
          records={records.records}
          columns={tableColumns(records.fields)}
          onOpen={(record) => setEditing({ kind: "existing", recordId: record.id })}
        />
      )}
      {records?.truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the {records.records.length} most recently changed records.
        </p>
      ) : null}
      {records !== null && records.malformed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden />
          <AlertDescription>
            <span>These files could not be read as records:</span>
            <ul className="grid gap-0.5">
              {records.malformed.map((file) => (
                <li key={file.path}>
                  <code className="font-mono text-xs">{file.path}</code> {file.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {editing !== null ? (
        <RecordDialog
          key={editing.kind === "new" ? "new" : editing.recordId}
          {...props}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function RecordCard(props: {
  readonly record: CompanyBrainRecordSummary;
  readonly fields: ReadonlyArray<string>;
  readonly onOpen: () => void;
}) {
  const details = props.fields
    .map((field) => formatFieldValue(props.record.fields[field]))
    .filter((value) => value !== "")
    .slice(0, 2);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="w-full truncate text-sm">{props.record.title}</span>
      {details.map((detail) => (
        <span key={detail} className="w-full truncate text-xs text-muted-foreground">
          {detail}
        </span>
      ))}
    </button>
  );
}

function RecordTable(props: {
  readonly records: ReadonlyArray<CompanyBrainRecordSummary>;
  readonly columns: ReadonlyArray<string>;
  readonly onOpen: (record: CompanyBrainRecordSummary) => void;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            {props.columns.map((column) => (
              <TableHead key={column}>
                <span className="capitalize">{column}</span>
              </TableHead>
            ))}
            <TableHead className="text-right">Changed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.records.map((record) => (
            <TableRow
              key={record.id}
              tabIndex={0}
              className="cursor-pointer"
              onClick={() => props.onOpen(record)}
              onKeyDown={(event) => {
                if (event.key === "Enter") props.onOpen(record);
              }}
            >
              <TableCell>
                <span className="block max-w-56 truncate text-sm">{record.title}</span>
              </TableCell>
              {props.columns.map((column) => (
                <TableCell key={column}>
                  <span className="block max-w-48 truncate text-muted-foreground">
                    {formatFieldValue(record.fields[column])}
                  </span>
                </TableCell>
              ))}
              <TableCell className="text-right">
                <span className="tabular-nums text-muted-foreground">
                  {record.updatedAt
                    ? formatRelativeTimeLabel(DateTime.formatIso(record.updatedAt))
                    : ""}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RecordDialog(
  props: BrainTarget & {
    readonly collection: CompanyBrainCollection;
    readonly canWrite: boolean;
    readonly editing: Editing;
    readonly onClose: () => void;
  },
) {
  if (props.editing.kind === "new") return <RecordEditor {...props} record={null} />;
  return <ExistingRecordDialog {...props} recordId={props.editing.recordId} />;
}

function ExistingRecordDialog(
  props: BrainTarget & {
    readonly collection: CompanyBrainCollection;
    readonly canWrite: boolean;
    readonly recordId: CompanyBrainRecordId;
    readonly onClose: () => void;
  },
) {
  const result = useAtomValue(
    companyBrainEnvironment.record({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: props.collection.id,
        recordId: props.recordId,
      },
    }),
  );
  if (result._tag === "Success") return <RecordEditor {...props} record={result.value} />;
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.collection.label}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {result._tag === "Failure" ? (
            <Alert variant="error">
              <AlertDescription>{brainFailure(result.cause).message}</AlertDescription>
            </Alert>
          ) : (
            <Spinner />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function RecordEditor(
  props: BrainTarget & {
    readonly collection: CompanyBrainCollection;
    readonly canWrite: boolean;
    readonly record: CompanyBrainRecord | null;
    readonly onClose: () => void;
  },
) {
  const saveRecord = useAtomCommand(companyBrainEnvironment.saveRecord, { reportFailure: false });
  const deleteRecord = useAtomCommand(companyBrainEnvironment.deleteRecord, {
    label: "delete record",
  });
  const { stageField, stages } = props.collection;
  const original = props.record?.fields ?? {};
  const initialStage = typeof original[stageField] === "string" ? original[stageField] : "";
  const [title, setTitle] = useState(props.record?.title ?? "");
  const [stage, setStage] = useState(initialStage);
  const [rows, setRows] = useState<ReadonlyArray<FieldRow & { readonly rowId: number }>>(() =>
    fieldRowsOf(original)
      .filter((row) => stages.length === 0 || row.key !== stageField)
      .map((row, rowId) => ({ ...row, rowId })),
  );
  const [nextRowId, setNextRowId] = useState(rows.length);
  const [body, setBody] = useState(props.record?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rowsToSave =
    stages.length === 0
      ? rows
      : [...rows, ...(stage === "" ? [] : [{ key: stageField, value: stage }])];
  const changes = fieldChanges(original, rowsToSave);
  const titleChanged = title.trim() !== "" && title.trim() !== props.record?.title;
  const dirty =
    titleChanged ||
    body !== (props.record?.body ?? "") ||
    Object.keys(changes.set).length > 0 ||
    changes.unset.length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await saveRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: props.collection.id,
        ...(props.record === null ? {} : { recordId: props.record.id }),
        ...(titleChanged ? { title: title.trim() } : {}),
        set: changes.set,
        unset: changes.unset,
        ...(body !== (props.record?.body ?? "") ? { body } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") props.onClose();
    else setError(brainFailure(result.cause).message);
  };

  const remove = async () => {
    if (props.record === null) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete ${props.record.title}?\nIts file ${props.record.path} is deleted.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = await deleteRecord({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        collection: props.collection.id,
        recordId: props.record.id,
      },
    });
    if (result._tag === "Success") props.onClose();
  };

  const updateRow = (index: number, patch: Partial<FieldRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {props.record === null ? `New in ${props.collection.label}` : props.record.title}
          </DialogTitle>
          <DialogDescription>
            {props.record === null
              ? `Saved as a file in company/${props.collection.id}/.`
              : `${props.record.path}${
                  props.record.updatedAt
                    ? ` · changed ${formatRelativeTimeLabel(DateTime.formatIso(props.record.updatedAt))}`
                    : ""
                }`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="record-title">Name</Label>
              <Input
                id="record-title"
                value={title}
                disabled={!props.canWrite}
                autoFocus={props.record === null}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            {stages.length > 0 ? (
              <div className="grid gap-1.5">
                <Label>Stage</Label>
                <Select
                  value={stage}
                  disabled={!props.canWrite}
                  onValueChange={(value) => setStage(value ?? "")}
                >
                  <SelectTrigger aria-label="Stage" size="sm" className="w-48">
                    <SelectValue>{stage === "" ? NO_STAGE : stage}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="">{NO_STAGE}</SelectItem>
                    {[...stages, ...(stage !== "" && !stages.includes(stage) ? [stage] : [])].map(
                      (option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ),
                    )}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label>Fields</Label>
              {rows.map((row, index) => (
                <div key={row.rowId} className="flex items-center gap-1.5">
                  <Input
                    aria-label="Field name"
                    size="sm"
                    className="w-36"
                    value={row.key}
                    disabled={!props.canWrite}
                    onChange={(event) => updateRow(index, { key: event.target.value })}
                  />
                  <Input
                    aria-label={`${row.key || "Field"} value`}
                    size="sm"
                    className="min-w-0 flex-1"
                    value={row.value}
                    disabled={!props.canWrite}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${row.key || "field"}`}
                    disabled={!props.canWrite}
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ))}
              <Button
                size="xs"
                variant="ghost"
                className="justify-self-start"
                disabled={!props.canWrite}
                onClick={() => {
                  setRows((current) => [...current, { key: "", value: "", rowId: nextRowId }]);
                  setNextRowId((id) => id + 1);
                }}
              >
                <PlusIcon aria-hidden />
                Add field
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="record-body">Notes</Label>
              <Textarea
                id="record-body"
                size="lg"
                value={body}
                disabled={!props.canWrite}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
          </div>
          {error !== null ? (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {props.record !== null ? (
            <Button
              variant="ghost-destructive"
              className="sm:mr-auto"
              disabled={!props.canWrite || busy}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !props.canWrite || busy || !dirty || (props.record === null && title.trim() === "")
            }
            onClick={() => void save()}
          >
            {busy ? <Spinner /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const folderNameOf = (label: string) =>
  label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function NewCollectionDialog(props: {
  readonly onClose: () => void;
  readonly onCreate: (input: {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly stages: ReadonlyArray<string>;
  }) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [stages, setStages] = useState("");
  const [busy, setBusy] = useState(false);
  const id = folderNameOf(label);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New collection</DialogTitle>
          <DialogDescription>
            {id
              ? `A folder at company/${id}/, one file per record.`
              : "One folder, one file per record."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="collection-label">Name</Label>
              <Input
                id="collection-label"
                placeholder="Partners"
                value={label}
                autoFocus
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="collection-stages">Stages (optional)</Label>
              <Input
                id="collection-stages"
                placeholder="intro, pilot, signed"
                value={stages}
                onChange={(event) => setStages(event.target.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || id === "" || id === "outbox"}
            onClick={async () => {
              setBusy(true);
              await props.onCreate({
                id,
                label: label.trim(),
                description: "",
                stages: stages
                  .split(",")
                  .map((stage) => stage.trim())
                  .filter((stage) => stage !== ""),
              });
              setBusy(false);
            }}
          >
            {busy ? <Spinner /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
