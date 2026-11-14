import {
  type CompanyBrainConnectInput,
  type CompanyBrainConnectResult,
  CompanyBrainError,
  type CompanyBrainFailure,
  type CompanyBrainSource as CompanyBrainSourceState,
  type ProjectId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { BRAIN_DIR } from "./brainFile.ts";
import { parseGitStatus, parseRepositoryInput, redactUrl } from "./brainSource.ts";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } satisfies NodeJS.ProcessEnv;
const NETWORK_TIMEOUT_MS = 120_000;
const COMMIT_MESSAGE = "Update company brain from T4";
const EXCLUDE_LINE = `/${BRAIN_DIR}/`;

export class CompanyBrainSource extends Context.Service<
  CompanyBrainSource,
  {
    readonly status: (
      projectId: ProjectId,
    ) => Effect.Effect<CompanyBrainSourceState, CompanyBrainError>;
    /** Clones the repo as `company/`, keeping files only this folder had. */
    readonly connect: (
      input: CompanyBrainConnectInput,
    ) => Effect.Effect<CompanyBrainConnectResult, CompanyBrainError>;
    /** Commits what changed here, rebases onto the remote, and pushes. */
    readonly sync: (
      projectId: ProjectId,
    ) => Effect.Effect<CompanyBrainSourceState, CompanyBrainError>;
    /** Keeps the files and forgets the repo. */
    readonly disconnect: (
      projectId: ProjectId,
    ) => Effect.Effect<CompanyBrainSourceState, CompanyBrainError>;
  }
>()("t3/companyBrain/CompanyBrainSource") {}

const brainError = (reason: CompanyBrainFailure, message: string) =>
  new CompanyBrainError({ reason, message });

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const vcs = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  // Connecting, syncing and disconnecting all rewrite the folder or its history.
  const busy = yield* Semaphore.make(1);

  const storage =
    (message: string) =>
    (_cause: unknown): Effect.Effect<never, CompanyBrainError> =>
      Effect.fail(brainError("storage", message));

  const brainPath = Effect.fn("CompanyBrainSource.brainPath")(function* (projectId: ProjectId) {
    const shell = yield* projects
      .getShell(projectId)
      .pipe(Effect.catch(storage("Could not read the project.")));
    if (Option.isNone(shell)) {
      return yield* brainError("unknown_project", "That project does not exist.");
    }
    const root = shell.value.workspaceRoot;
    return { root, brain: path.join(root, BRAIN_DIR) };
  });

  const git = (cwd: string, args: ReadonlyArray<string>, timeoutMs?: number) =>
    vcs
      .run({
        operation: "CompanyBrainSource.git",
        command: "git",
        args,
        cwd,
        env: GIT_ENV,
        allowNonZeroExit: true,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
      .pipe(
        Effect.mapError(() => brainError("git_failed", "Git could not run on this machine.")),
        Effect.map((output) => ({
          ok: output.exitCode === 0,
          stdout: output.stdout,
          stderr: redactUrl(output.stderr.trim()),
        })),
      );

  const gitOrFail = (
    cwd: string,
    args: ReadonlyArray<string>,
    message: string,
    timeoutMs?: number,
  ) =>
    git(cwd, args, timeoutMs).pipe(
      Effect.flatMap((result) =>
        result.ok
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              brainError(
                "git_failed",
                result.stderr === "" ? message : `${message} ${result.stderr}`,
              ),
            ),
      ),
    );

  const isConnected = (brain: string) =>
    fileSystem.exists(path.join(brain, ".git")).pipe(Effect.orElseSucceed(() => false));

  const readStatus = Effect.fn("CompanyBrainSource.readStatus")(function* (brain: string) {
    if (!(yield* isConnected(brain))) return { _tag: "local" } as const;
    const status = yield* gitOrFail(
      brain,
      ["status", "--porcelain=v2", "--branch"],
      "Could not read the brain repo's status.",
    );
    const remote = yield* git(brain, ["remote", "get-url", "origin"]);
    return {
      _tag: "git",
      remoteUrl: remote.ok ? redactUrl(remote.stdout.trim()) : "",
      ...parseGitStatus(status),
    } as const;
  });

  const status: CompanyBrainSource["Service"]["status"] = Effect.fn("CompanyBrainSource.status")(
    function* (projectId) {
      return yield* readStatus((yield* brainPath(projectId)).brain);
    },
  );

  const requireConnected = Effect.fn("CompanyBrainSource.requireConnected")(function* (
    projectId: ProjectId,
  ) {
    const paths = yield* brainPath(projectId);
    if (!(yield* isConnected(paths.brain))) {
      return yield* brainError("not_connected", "The company brain is not connected to a repo.");
    }
    return paths;
  });

  /** Keeps the outer project's git from listing the brain repo as untracked files. */
  const setExcluded = Effect.fn("CompanyBrainSource.setExcluded")(function* (
    root: string,
    excluded: boolean,
  ) {
    const inside = yield* git(root, ["rev-parse", "--git-path", "info/exclude"]);
    if (!inside.ok) return;
    const excludePath = path.resolve(root, inside.stdout.trim());
    const current = yield* fileSystem
      .readFileString(excludePath)
      .pipe(Effect.orElseSucceed(() => ""));
    const others = current
      .split("\n")
      .filter((line) => line.trim() !== EXCLUDE_LINE)
      .join("\n")
      .replace(/\n*$/, "");
    const lines = [...(others === "" ? [] : [others]), ...(excluded ? [EXCLUDE_LINE] : [])];
    const next = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    if (next === current) return;
    yield* fileSystem
      .makeDirectory(path.dirname(excludePath), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(excludePath, next)),
        Effect.catch(storage("Could not update the project's git exclude file.")),
      );
  });

  const listFiles = Effect.fn("CompanyBrainSource.listFiles")(function* (directory: string) {
    const entries = yield* fileSystem
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.catch(storage("Could not read the company folder.")));
    const files: Array<string> = [];
    for (const entry of entries) {
      if (entry === ".git" || entry.startsWith(`.git${path.sep}`)) continue;
      const info = yield* fileSystem.stat(path.join(directory, entry)).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "File") files.push(entry);
    }
    return files;
  });

  const copyInto = (from: string, to: string) =>
    fileSystem
      .makeDirectory(path.dirname(to), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.copyFile(from, to)),
        Effect.catch(storage("Could not move the company folder's files into the repo.")),
      );

  const sameContents = (a: string, b: string) =>
    Effect.all([fileSystem.readFile(a), fileSystem.readFile(b)]).pipe(
      Effect.map(([left, right]) => Buffer.from(left).equals(Buffer.from(right))),
      Effect.orElseSucceed(() => false),
    );

  const connect: CompanyBrainSource["Service"]["connect"] = Effect.fn("CompanyBrainSource.connect")(
    function* (input) {
      const { root, brain } = yield* brainPath(input.projectId);
      const target = parseRepositoryInput(input.repository);
      if (target === null) {
        return yield* brainError(
          "invalid_input",
          "Enter a GitHub repo like acme/brain, or a git clone URL.",
        );
      }
      return yield* busy.withPermit(
        Effect.gen(function* () {
          if (yield* isConnected(brain)) {
            return yield* brainError(
              "already_connected",
              "The company brain already syncs with a repo.",
            );
          }
          const staging = path.join(
            root,
            `.${BRAIN_DIR}-connect-${Hex.encode(yield* crypto.randomBytes(4).pipe(Effect.orDie))}`,
          );
          yield* repositories
            .cloneRepository({
              ...(target._tag === "github"
                ? {
                    provider: SourceControlProviderKind.make("github"),
                    repository: target.repository,
                  }
                : { remoteUrl: target.url }),
              destinationPath: staging,
            })
            .pipe(
              Effect.catch((error) =>
                repositories
                  .discardClone(staging)
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.fail(
                        brainError("git_failed", `Could not clone the repo. ${error.detail}`),
                      ),
                    ),
                  ),
              ),
            );

          let kept = 0;
          let backupPath: string | null = null;
          if (yield* fileSystem.exists(brain).pipe(Effect.orElseSucceed(() => false))) {
            const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
            for (const file of yield* listFiles(brain)) {
              const local = path.join(brain, file);
              const incoming = path.join(staging, file);
              if (!(yield* fileSystem.exists(incoming).pipe(Effect.orElseSucceed(() => false)))) {
                yield* copyInto(local, incoming);
                kept++;
              } else if (!(yield* sameContents(local, incoming))) {
                backupPath ??= path.join(
                  config.stateDir,
                  "company-brain-backups",
                  `${input.projectId}-${stamp}`,
                );
                yield* copyInto(local, path.join(backupPath, file));
              }
            }
            yield* fileSystem
              .remove(brain, { recursive: true })
              .pipe(Effect.catch(storage("Could not replace the company folder.")));
          }
          yield* fileSystem
            .rename(staging, brain)
            .pipe(Effect.catch(storage("Could not move the cloned repo into place.")));
          yield* setExcluded(root, true);
          return { source: yield* readStatus(brain), kept, backupPath };
        }),
      );
    },
  );

  const sync: CompanyBrainSource["Service"]["sync"] = Effect.fn("CompanyBrainSource.sync")(
    function* (projectId) {
      const { brain } = yield* requireConnected(projectId);
      return yield* busy.withPermit(
        Effect.gen(function* () {
          yield* gitOrFail(brain, ["add", "-A"], "Could not stage the brain's changes.");
          const staged = yield* git(brain, ["diff", "--cached", "--quiet"]);
          if (!staged.ok) {
            const hasIdentity = (yield* git(brain, ["config", "user.email"])).ok;
            yield* gitOrFail(
              brain,
              [
                ...(hasIdentity ? [] : ["-c", "user.name=T4", "-c", "user.email=t4@localhost"]),
                "commit",
                "-m",
                COMMIT_MESSAGE,
              ],
              "Could not commit the brain's changes.",
            );
          }
          const upstream = yield* git(brain, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
          if (upstream.ok) {
            const pulled = yield* git(brain, ["pull", "--rebase"], NETWORK_TIMEOUT_MS);
            if (!pulled.ok) {
              const conflicted = yield* git(brain, ["diff", "--name-only", "--diff-filter=U"]);
              const files = conflicted.stdout.split("\n").filter((line) => line.trim() !== "");
              yield* git(brain, ["rebase", "--abort"]);
              return yield* files.length > 0
                ? brainError(
                    "conflict",
                    `These files changed both here and in the repo: ${files.join(", ")}. Your changes are committed locally; merge them in the repo, then sync again.`,
                  )
                : brainError("git_failed", `Could not pull from the repo. ${pulled.stderr}`);
            }
          }
          const current = yield* readStatus(brain);
          if (!upstream.ok || (current._tag === "git" && current.ahead > 0)) {
            yield* gitOrFail(
              brain,
              upstream.ok ? ["push"] : ["push", "-u", "origin", "HEAD"],
              "Could not push to the repo.",
              NETWORK_TIMEOUT_MS,
            );
          }
          return yield* readStatus(brain);
        }),
      );
    },
  );

  const disconnect: CompanyBrainSource["Service"]["disconnect"] = Effect.fn(
    "CompanyBrainSource.disconnect",
  )(function* (projectId) {
    const { root, brain } = yield* requireConnected(projectId);
    return yield* busy.withPermit(
      Effect.gen(function* () {
        yield* fileSystem
          .remove(path.join(brain, ".git"), { recursive: true })
          .pipe(Effect.catch(storage("Could not disconnect the repo.")));
        yield* setExcluded(root, false);
        return yield* readStatus(brain);
      }),
    );
  });

  return CompanyBrainSource.of({ status, connect, sync, disconnect });
});

export const layer = Layer.effect(CompanyBrainSource, make);
