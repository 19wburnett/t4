import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CompanyBrainCollectionId,
  type CompanyBrainError,
  CompanyBrainRecordId,
  type OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CompanyBrain from "./CompanyBrain.ts";

const projectId = ProjectId.make("project-1");
const deals = CompanyBrainCollectionId.make("deals");

const withBrain = <A, E>(
  use: (input: {
    readonly brain: CompanyBrain.CompanyBrain["Service"];
    readonly root: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-brain-" });
    const layer = CompanyBrain.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getShell: (id) =>
              Effect.succeed(
                id === projectId
                  ? Option.some({ id, workspaceRoot: root } as OrchestrationProjectShell)
                  : Option.none(),
              ),
          }),
          WorkspaceFileSystem.layer.pipe(
            Layer.provide(
              Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
            ),
            Layer.provide(
              Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
            ),
            Layer.provide(WorkspacePaths.layer),
          ),
          WorkspacePaths.layer,
        ).pipe(
          Layer.provideMerge(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-brain-state-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* use({ brain: yield* CompanyBrain.CompanyBrain, root });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("CompanyBrain", () => {
  it.effect("keeps records as files in company folders, readable by hand and by agents", () =>
    withBrain(({ brain, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${root}/company/outbox`, { recursive: true });
        yield* fileSystem.makeDirectory(`${root}/company/notes`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/company/notes/Pricing.md`, "# Pricing\n");
        yield* fileSystem.writeFileString(
          `${root}/company/notes/broken.md`,
          "---\nname: [x\n---\n",
        );

        yield* brain.saveCollection({
          projectId,
          collection: deals,
          label: "Deals",
          stages: ["lead", "meeting", "won"],
        });
        const first = yield* brain.saveRecord({
          projectId,
          collection: deals,
          title: "Acme Corp",
          set: { stage: "lead", value: 12000 },
        });
        const second = yield* brain.saveRecord({
          projectId,
          collection: deals,
          title: "Acme Corp",
        });
        expect([first.id, second.id]).toEqual(["acme-corp", "acme-corp-2"]);

        const updated = yield* brain.saveRecord({
          projectId,
          collection: deals,
          recordId: first.id,
          set: { stage: "meeting" },
          note: "Demo booked for Tuesday",
          author: "Grok Bot",
        });
        expect(updated.fields).toEqual({ name: "Acme Corp", stage: "meeting", value: 12000 });
        expect(updated.body).toMatch(
          /^## Log\n\n- \d{4}-\d{2}-\d{2} Grok Bot: Demo booked for Tuesday\n$/,
        );
        expect(yield* fileSystem.readFileString(`${root}/company/deals/acme-corp.md`)).toMatch(
          /^---\nname: Acme Corp\nstage: meeting\nvalue: 12000\n---\n## Log/,
        );

        const { collections } = yield* brain.listCollections(projectId);
        expect(
          collections.map(({ id, label, stages, recordCount }) => ({
            id,
            label,
            stages,
            recordCount,
          })),
        ).toEqual([
          { id: "deals", label: "Deals", stages: ["lead", "meeting", "won"], recordCount: 2 },
          { id: "notes", label: "notes", stages: [], recordCount: 2 },
        ]);
        const notes = yield* brain.listRecords({
          projectId,
          collection: CompanyBrainCollectionId.make("notes"),
        });
        expect(notes.records.map((record) => record.title)).toEqual(["Pricing"]);
        expect(notes.malformed).toEqual([
          { path: "company/notes/broken.md", message: "The frontmatter is not valid YAML." },
        ]);
        expect((yield* brain.listRecords({ projectId, collection: deals })).fields).toEqual([
          "name",
          "stage",
          "value",
        ]);

        expect(
          yield* brain.deleteRecord({ projectId, collection: deals, recordId: second.id }),
        ).toBe(true);
        expect(
          yield* brain.deleteRecord({ projectId, collection: deals, recordId: second.id }),
        ).toBe(false);
      }),
    ),
  );

  it.effect("refuses edits that would lose data or escape the brain", () =>
    withBrain(({ brain, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${root}/company/deals`, { recursive: true });
        yield* fileSystem.writeFileString(
          `${root}/company/deals/x.md`,
          "---\nname: [x\n---\nKeep me\n",
        );
        const reason = <A>(effect: Effect.Effect<A, CompanyBrainError>) =>
          Effect.flip(effect).pipe(Effect.map((error) => error.reason));
        const failures = [
          yield* reason(
            brain.saveRecord({
              projectId,
              collection: deals,
              recordId: CompanyBrainRecordId.make("x"),
              set: { stage: "won" },
            }),
          ),
          yield* reason(brain.saveRecord({ projectId, collection: deals, set: { stage: "won" } })),
          yield* reason(
            brain.saveRecord({
              projectId,
              collection: CompanyBrainCollectionId.make("outbox"),
              title: "Hi",
            }),
          ),
          yield* reason(
            brain.listRecords({ projectId, collection: CompanyBrainCollectionId.make("missing") }),
          ),
        ];
        expect(failures).toEqual([
          "malformed",
          "invalid_input",
          "invalid_input",
          "unknown_collection",
        ]);
        expect(yield* fileSystem.readFileString(`${root}/company/deals/x.md`)).toBe(
          "---\nname: [x\n---\nKeep me\n",
        );
      }),
    ),
  );
});
