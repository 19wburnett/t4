import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CompanyBrainSource from "./CompanyBrainSource.ts";

const projectId = ProjectId.make("project-1");
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

const git = (cwd: string, ...args: Array<string>) =>
  VcsProcess.VcsProcess.pipe(
    Effect.flatMap((vcs) => vcs.run({ operation: "test", command: "git", args, cwd })),
  );

/** The service over a real project folder, cloning with plain git instead of the GitHub lookup. */
const sourceFor = (root: string, vcs: VcsProcess.VcsProcess["Service"]) =>
  CompanyBrainSource.layer.pipe(
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
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          cloneRepository: (input) =>
            git(root, "clone", "-q", input.remoteUrl ?? "", input.destinationPath).pipe(
              Effect.provideService(VcsProcess.VcsProcess, vcs),
              Effect.orDie,
              Effect.as({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              }),
            ),
          discardClone: () => Effect.void,
        }),
        ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-brain-source-state-" }),
      ),
    ),
  );

describe("CompanyBrainSource", () => {
  it.live("connects a repo, keeps local files, syncs both ways, and disconnects", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-brain-source-" });

      // A remote brain with a person, and a project whose own brain differs from it.
      const remote = `${tmp}/remote.git`;
      yield* fileSystem.makeDirectory(`${tmp}/seed/people`, { recursive: true });
      yield* fileSystem.writeFileString(`${tmp}/seed/people/ada.md`, "---\nname: Ada\n---\n");
      yield* fileSystem.writeFileString(`${tmp}/seed/BRAIN.md`, "# Repo brain\n");
      yield* git(tmp, "init", "-q", "--bare", "-b", "main", remote);
      yield* git(`${tmp}/seed`, "init", "-q", "-b", "main");
      yield* git(`${tmp}/seed`, "add", "-A");
      yield* git(`${tmp}/seed`, ...identity, "commit", "-q", "-m", "seed");
      yield* git(`${tmp}/seed`, "push", "-q", remote, "main");

      const root = `${tmp}/project`;
      yield* fileSystem.makeDirectory(`${root}/company/deals`, { recursive: true });
      yield* git(root, "init", "-q");
      yield* fileSystem.writeFileString(`${root}/company/BRAIN.md`, "# Local brain\n");
      yield* fileSystem.writeFileString(
        `${root}/company/deals/globex.md`,
        "---\nname: Globex\n---\n",
      );

      yield* Effect.gen(function* () {
        const source = yield* CompanyBrainSource.CompanyBrainSource;
        const connected = yield* source.connect({ projectId, repository: `file://${remote}` });
        expect(connected.kept).toBe(1);
        expect(connected.source).toMatchObject({ _tag: "git", branch: "main", changes: 1 });
        expect(yield* fileSystem.readFileString(`${root}/company/BRAIN.md`)).toBe("# Repo brain\n");
        expect(yield* fileSystem.readFileString(`${connected.backupPath}/BRAIN.md`)).toBe(
          "# Local brain\n",
        );
        expect((yield* git(root, "status", "--porcelain")).stdout).toBe("");

        expect(yield* source.sync(projectId)).toMatchObject({ changes: 0, ahead: 0, behind: 0 });
        const pushed = yield* git(
          tmp,
          `--git-dir=${remote}`,
          "ls-tree",
          "-r",
          "--name-only",
          "main",
        );
        expect(pushed.stdout.split("\n")).toContain("deals/globex.md");

        expect(yield* source.disconnect(projectId)).toEqual({ _tag: "local" });
        expect((yield* git(root, "status", "--porcelain")).stdout).toContain("company/");
        expect(yield* fileSystem.exists(`${root}/company/people/ada.md`)).toBe(true);
      }).pipe(Effect.provide(sourceFor(root, yield* VcsProcess.VcsProcess)));
    }).pipe(
      Effect.scoped,
      Effect.provide(VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );
});
