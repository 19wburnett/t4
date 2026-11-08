import {
  type CompanyBrainCollection,
  CompanyBrainCollectionId,
  type CompanyBrainCollectionInput,
  type CompanyBrainCollectionList,
  type CompanyBrainCollectionSaveInput,
  CompanyBrainError,
  type CompanyBrainFailure,
  type CompanyBrainMalformedFile,
  type CompanyBrainRecord,
  CompanyBrainRecordId,
  type CompanyBrainRecordInput,
  type CompanyBrainRecordList,
  type CompanyBrainRecordSaveInput,
  type CompanyBrainRecordSummary,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  BRAIN_DIR,
  COLLECTION_README,
  fieldNamesByUse,
  isCollectionFolder,
  parseCollectionReadme,
  parseRecord,
  recordIdFromFileName,
  recordTitle,
  slugify,
  updateCollectionReadme,
  updateRecord,
} from "./brainFile.ts";

// One listing stays small enough to send to every client that opens the hub.
const MAX_RECORDS_PER_LISTING = 1_000;

export class CompanyBrain extends Context.Service<
  CompanyBrain,
  {
    readonly listCollections: (
      projectId: ProjectId,
    ) => Effect.Effect<CompanyBrainCollectionList, CompanyBrainError>;
    readonly listRecords: (
      input: CompanyBrainCollectionInput,
    ) => Effect.Effect<CompanyBrainRecordList, CompanyBrainError>;
    readonly readRecord: (
      input: CompanyBrainRecordInput,
    ) => Effect.Effect<CompanyBrainRecord, CompanyBrainError>;
    /** `author` signs log notes: the agent's name, or "You". */
    readonly saveRecord: (
      input: CompanyBrainRecordSaveInput & { readonly author?: string },
    ) => Effect.Effect<CompanyBrainRecord, CompanyBrainError>;
    readonly deleteRecord: (
      input: CompanyBrainRecordInput,
    ) => Effect.Effect<boolean, CompanyBrainError>;
    readonly saveCollection: (
      input: CompanyBrainCollectionSaveInput,
    ) => Effect.Effect<CompanyBrainCollection, CompanyBrainError>;
  }
>()("t3/companyBrain/CompanyBrain") {}

const brainError = (reason: CompanyBrainFailure, message: string) =>
  new CompanyBrainError({ reason, message });

const storageFailure =
  (message: string) =>
  (_cause: unknown): Effect.Effect<never, CompanyBrainError> =>
    Effect.fail(brainError("storage", message));

const decodeCollectionId = Schema.decodeUnknownOption(CompanyBrainCollectionId);

const collectionPath = (collection: string) => `${BRAIN_DIR}/${collection}`;
const recordPath = (collection: string, id: string) => `${BRAIN_DIR}/${collection}/${id}.md`;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const workspaceFiles = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  // Saves read, merge, and write, so they go one at a time.
  const writes = yield* Semaphore.make(1);

  const requireProject = Effect.fn("CompanyBrain.requireProject")(function* (projectId: ProjectId) {
    const shell = yield* projects
      .getShell(projectId)
      .pipe(Effect.catch(storageFailure("Could not read the project.")));
    if (Option.isNone(shell)) {
      return yield* brainError("unknown_project", "That project does not exist.");
    }
    return shell.value.workspaceRoot;
  });

  const absolute = Effect.fn("CompanyBrain.absolute")(function* (
    workspaceRoot: string,
    relativePath: string,
  ) {
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
      .pipe(Effect.catch(storageFailure("The company folder is outside the project.")));
    return resolved.absolutePath;
  });

  /** Names in a folder, or null when there is no folder. */
  const readFolder = Effect.fn("CompanyBrain.readFolder")(function* (absolutePath: string) {
    return yield* fileSystem.readDirectory(absolutePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.catch(storageFailure("Could not list the company folder.")),
    );
  });

  const readText = Effect.fn("CompanyBrain.readText")(function* (
    workspaceRoot: string,
    relativePath: string,
  ) {
    const file = yield* workspaceFiles
      .readFile({ cwd: workspaceRoot, relativePath, allowMissing: true })
      .pipe(Effect.catch(storageFailure(`Could not read ${relativePath}.`)));
    if (file.exists === false) return { _tag: "Missing" } as const;
    if (file.truncated) return { _tag: "TooLarge" } as const;
    return { _tag: "Text", contents: file.contents } as const;
  });

  /** For files that configure, not hold, data: unreadable counts as absent. */
  const readOptionalText = (workspaceRoot: string, relativePath: string) =>
    readText(workspaceRoot, relativePath).pipe(
      Effect.map((file) => (file._tag === "Text" ? file.contents : null)),
    );

  const modifiedAt = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(
      Effect.map((info) =>
        Option.match(info.mtime, {
          onNone: () => null,
          onSome: (date) => DateTime.fromDateUnsafe(date),
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const describeCollection = Effect.fn("CompanyBrain.describeCollection")(function* (
    workspaceRoot: string,
    id: CompanyBrainCollectionId,
    names: ReadonlyArray<string>,
  ) {
    const readme = yield* readOptionalText(
      workspaceRoot,
      `${collectionPath(id)}/${COLLECTION_README}`,
    ).pipe(Effect.orElseSucceed(() => null));
    const config = parseCollectionReadme(readme);
    return {
      id,
      label: config.label ?? id,
      description: config.description,
      stageField: config.stageField,
      stages: [...config.stages],
      recordCount: names.filter((name) => recordIdFromFileName(name) !== null).length,
    } satisfies CompanyBrainCollection;
  });

  const requireCollection = Effect.fn("CompanyBrain.requireCollection")(function* (
    workspaceRoot: string,
    collection: CompanyBrainCollectionId,
  ) {
    if (!isCollectionFolder(collection)) {
      return yield* brainError("invalid_input", `${collection} is not a record collection.`);
    }
    const names = yield* readFolder(yield* absolute(workspaceRoot, collectionPath(collection)));
    if (names === null) {
      return yield* brainError(
        "unknown_collection",
        `There is no ${BRAIN_DIR}/${collection} folder.`,
      );
    }
    return { names, collection: yield* describeCollection(workspaceRoot, collection, names) };
  });

  const listCollections: CompanyBrain["Service"]["listCollections"] = Effect.fn(
    "CompanyBrain.listCollections",
  )(function* (projectId) {
    const workspaceRoot = yield* requireProject(projectId);
    const brainRoot = yield* absolute(workspaceRoot, BRAIN_DIR);
    const names = (yield* readFolder(brainRoot)) ?? [];
    const malformed: Array<CompanyBrainMalformedFile> = [];
    const collections = yield* Effect.forEach(
      names.filter(isCollectionFolder).toSorted(),
      (name) =>
        Effect.gen(function* () {
          const info = yield* fileSystem.stat(path.join(brainRoot, name)).pipe(Effect.option);
          if (Option.isNone(info) || info.value.type !== "Directory") return null;
          const id = Option.getOrNull(decodeCollectionId(name));
          if (id === null) {
            malformed.push({
              path: collectionPath(name),
              message: "The folder name cannot be used.",
            });
            return null;
          }
          const entries = (yield* readFolder(path.join(brainRoot, name))) ?? [];
          return yield* describeCollection(workspaceRoot, id, entries);
        }),
      { concurrency: 8 },
    );
    return {
      collections: collections
        .filter((collection) => collection !== null)
        .toSorted((a, b) => a.label.localeCompare(b.label)),
      malformed,
    };
  });

  const toRecord = (
    collection: CompanyBrainCollectionId,
    id: CompanyBrainRecordId,
    fields: CompanyBrainRecord["fields"],
    body: string,
    updatedAt: DateTime.Utc | null,
  ): CompanyBrainRecord => ({
    collection,
    id,
    path: recordPath(collection, id),
    title: recordTitle(id, fields),
    fields,
    updatedAt,
    body,
  });

  type RecordRead =
    | { readonly _tag: "Missing" }
    | { readonly _tag: "Malformed"; readonly message: string }
    | { readonly _tag: "Record"; readonly record: CompanyBrainRecord; readonly contents: string };

  const readRecordFile = Effect.fn("CompanyBrain.readRecordFile")(function* (
    workspaceRoot: string,
    collection: CompanyBrainCollectionId,
    id: CompanyBrainRecordId,
  ) {
    const relativePath = recordPath(collection, id);
    const file = yield* readText(workspaceRoot, relativePath);
    if (file._tag === "Missing") return { _tag: "Missing" } satisfies RecordRead;
    if (file._tag === "TooLarge") {
      return { _tag: "Malformed", message: "The file is too large to read." } satisfies RecordRead;
    }
    const contents = file.contents;
    const parsed = parseRecord(contents);
    if (parsed._tag === "Malformed") return parsed satisfies RecordRead;
    const updatedAt = yield* modifiedAt(yield* absolute(workspaceRoot, relativePath));
    return {
      _tag: "Record",
      record: toRecord(collection, id, parsed.fields, parsed.body, updatedAt),
      contents,
    } satisfies RecordRead;
  });

  const requireRecord = Effect.fn("CompanyBrain.requireRecord")(function* (
    workspaceRoot: string,
    collection: CompanyBrainCollectionId,
    id: CompanyBrainRecordId,
  ) {
    const read = yield* readRecordFile(workspaceRoot, collection, id);
    if (read._tag === "Missing") {
      return yield* brainError("unknown_record", `There is no ${recordPath(collection, id)}.`);
    }
    if (read._tag === "Malformed") {
      return yield* brainError("malformed", `${recordPath(collection, id)}: ${read.message}`);
    }
    return read;
  });

  const listRecords: CompanyBrain["Service"]["listRecords"] = Effect.fn("CompanyBrain.listRecords")(
    function* (input) {
      const workspaceRoot = yield* requireProject(input.projectId);
      const { names, collection } = yield* requireCollection(workspaceRoot, input.collection);
      const ids = names.flatMap((name) => {
        const id = recordIdFromFileName(name);
        return id === null ? [] : [id];
      });
      const reads = yield* Effect.forEach(
        ids,
        (id) =>
          readRecordFile(workspaceRoot, input.collection, id).pipe(
            Effect.map((read) => ({ id, read })),
          ),
        { concurrency: 16 },
      );
      const records: Array<CompanyBrainRecordSummary> = [];
      const malformed: Array<CompanyBrainMalformedFile> = [];
      for (const { id, read } of reads) {
        if (read._tag === "Record") {
          const { body: _body, ...summary } = read.record;
          records.push(summary);
        } else if (read._tag === "Malformed") {
          malformed.push({ path: recordPath(input.collection, id), message: read.message });
        }
      }
      records.sort(
        (a, b) =>
          (b.updatedAt === null ? 0 : DateTime.toEpochMillis(b.updatedAt)) -
          (a.updatedAt === null ? 0 : DateTime.toEpochMillis(a.updatedAt)),
      );
      return {
        collection,
        records: records.slice(0, MAX_RECORDS_PER_LISTING),
        fields: fieldNamesByUse(records),
        truncated: records.length > MAX_RECORDS_PER_LISTING,
        malformed,
      };
    },
  );

  const readRecord: CompanyBrain["Service"]["readRecord"] = Effect.fn("CompanyBrain.readRecord")(
    function* (input) {
      const workspaceRoot = yield* requireProject(input.projectId);
      return (yield* requireRecord(workspaceRoot, input.collection, input.recordId)).record;
    },
  );

  const freeRecordId = Effect.fn("CompanyBrain.freeRecordId")(function* (
    workspaceRoot: string,
    collection: CompanyBrainCollectionId,
    title: string,
  ) {
    const base = slugify(title);
    const existing = new Set(
      (yield* readFolder(yield* absolute(workspaceRoot, collectionPath(collection)))) ?? [],
    );
    let candidate = base;
    for (let suffix = 2; existing.has(`${candidate}.md`); suffix++) candidate = `${base}-${suffix}`;
    return CompanyBrainRecordId.make(candidate);
  });

  const saveRecord: CompanyBrain["Service"]["saveRecord"] = Effect.fn("CompanyBrain.saveRecord")(
    function* (input) {
      const workspaceRoot = yield* requireProject(input.projectId);
      if (!isCollectionFolder(input.collection)) {
        return yield* brainError(
          "invalid_input",
          `${input.collection} is not a record collection.`,
        );
      }
      if (Object.keys(input.set ?? {}).some((key) => key.trim() === "")) {
        return yield* brainError("invalid_input", "Field names cannot be empty.");
      }
      return yield* writes.withPermit(
        Effect.gen(function* () {
          let id: CompanyBrainRecordId;
          let previous: { readonly contents: string; readonly record: CompanyBrainRecord } | null;
          if (input.recordId === undefined) {
            if (input.title === undefined) {
              return yield* brainError("invalid_input", "A new record needs a title.");
            }
            id = yield* freeRecordId(workspaceRoot, input.collection, input.title);
            previous = null;
          } else {
            id = input.recordId;
            previous = yield* requireRecord(workspaceRoot, input.collection, id);
          }
          const titleField =
            previous !== null &&
            !("name" in previous.record.fields) &&
            "title" in previous.record.fields
              ? "title"
              : "name";
          const now = yield* DateTime.now;
          const updated = updateRecord(previous?.contents ?? null, {
            set: {
              ...(input.title === undefined ? {} : { [titleField]: input.title }),
              ...input.set,
            },
            ...(input.unset === undefined ? {} : { unset: input.unset }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.note === undefined
              ? {}
              : {
                  logEntry: `${DateTime.formatIso(now).slice(0, 10)} ${input.author?.trim() || "You"}: ${input.note}`,
                }),
          });
          if (updated._tag === "Malformed" || updated.contents === undefined) {
            return yield* brainError(
              "malformed",
              `${recordPath(input.collection, id)}: ${updated._tag === "Malformed" ? updated.message : "could not be saved."}`,
            );
          }
          yield* workspaceFiles
            .writeFile({
              cwd: workspaceRoot,
              relativePath: recordPath(input.collection, id),
              contents: updated.contents,
            })
            .pipe(Effect.catch(storageFailure("Could not save the record.")));
          return toRecord(input.collection, id, updated.fields, updated.body, now);
        }),
      );
    },
  );

  const deleteRecord: CompanyBrain["Service"]["deleteRecord"] = Effect.fn(
    "CompanyBrain.deleteRecord",
  )(function* (input) {
    const workspaceRoot = yield* requireProject(input.projectId);
    const target = yield* absolute(workspaceRoot, recordPath(input.collection, input.recordId));
    return yield* writes.withPermit(
      fileSystem.remove(target).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
        Effect.catch(storageFailure("Could not delete the record.")),
      ),
    );
  });

  const saveCollection: CompanyBrain["Service"]["saveCollection"] = Effect.fn(
    "CompanyBrain.saveCollection",
  )(function* (input) {
    const workspaceRoot = yield* requireProject(input.projectId);
    if (!isCollectionFolder(input.collection)) {
      return yield* brainError("invalid_input", `${input.collection} is a reserved folder name.`);
    }
    const readmePath = `${collectionPath(input.collection)}/${COLLECTION_README}`;
    yield* writes.withPermit(
      Effect.gen(function* () {
        const file = yield* readText(workspaceRoot, readmePath);
        if (file._tag === "TooLarge") {
          return yield* brainError("malformed", `${readmePath} is too large to edit here.`);
        }
        const previous = file._tag === "Text" ? file.contents : null;
        const label = input.label ?? (previous === null ? input.collection : undefined);
        const updated = updateCollectionReadme(previous, {
          ...(label === undefined ? {} : { label }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.stages === undefined ? {} : { stages: input.stages }),
        });
        if (updated._tag === "Malformed" || updated.contents === undefined) {
          return yield* brainError(
            "malformed",
            `${readmePath}: ${updated._tag === "Malformed" ? updated.message : "could not be saved."}`,
          );
        }
        yield* workspaceFiles
          .writeFile({ cwd: workspaceRoot, relativePath: readmePath, contents: updated.contents })
          .pipe(Effect.catch(storageFailure("Could not save the collection.")));
      }),
    );
    return (yield* requireCollection(workspaceRoot, input.collection)).collection;
  });

  return CompanyBrain.of({
    listCollections,
    listRecords,
    readRecord,
    saveRecord,
    deleteRecord,
    saveCollection,
  });
});

export const layer = Layer.effect(CompanyBrain, make);
