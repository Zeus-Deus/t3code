import { PluginError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { snapshotPluginSource } from "./pluginSource.ts";

export const preparePluginRepair = Effect.fn("PluginRepair.prepare")(function* (input: {
  readonly directory: string;
  readonly destinationDirectory: string;
  readonly digest: string;
  readonly pluginId: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const snapshot = yield* snapshotPluginSource({
    directory: input.directory,
    destinationDirectory: input.destinationDirectory,
  });
  if (snapshot.digest !== input.digest)
    return yield* new PluginError({
      reason: "changed_source",
      message: "The active snapshot changed. No repair baseline was accepted.",
    });
  // The immutable snapshot copier collects bytes before writing; verify those copied bytes before
  // making them editable, so a concurrently modified active directory cannot become a baseline.
  const editable = Effect.fn("PluginRepair.makeEditable")(function* (
    directory: string,
  ): Effect.fn.Return<void, import("effect/PlatformError").PlatformError> {
    yield* fs.chmod(directory, 0o700);
    for (const name of yield* fs.readDirectory(directory)) {
      const file = path.join(directory, name);
      const stat = yield* fs.stat(file);
      if (stat.type === "Directory") yield* editable(file);
      else yield* fs.chmod(file, 0o600);
    }
  });
  yield* editable(snapshot.directory).pipe(
    Effect.mapError(
      () =>
        new PluginError({
          reason: "storage_failed",
          message: "The repair workspace could not be made editable.",
        }),
    ),
  );
  const git = Effect.fn("PluginRepair.git")(function* (args: ReadonlyArray<string>) {
    const result = yield* runner
      .run({
        command: "git",
        cwd: snapshot.directory,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=T3 Code",
          "-c",
          "user.email=plugin-repair@localhost",
          ...args,
        ],
        env: {
          GIT_DIR: path.join(snapshot.directory, ".git"),
          GIT_WORK_TREE: snapshot.directory,
          GIT_COMMON_DIR: path.join(snapshot.directory, ".git"),
          GIT_INDEX_FILE: path.join(snapshot.directory, ".git", "index"),
          GIT_OBJECT_DIRECTORY: path.join(snapshot.directory, ".git", "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
          GIT_NAMESPACE: "",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxOutputBytes: 16_000,
        timeout: "30 seconds",
      })
      .pipe(
        Effect.mapError(
          () =>
            new PluginError({
              reason: "operation_failed",
              message:
                "The repair baseline could not be committed. The workspace files were retained.",
            }),
        ),
      );
    if (result.code !== 0)
      return yield* new PluginError({
        reason: "operation_failed",
        message: "The repair baseline could not be committed. The workspace files were retained.",
      });
  });
  yield* git(["init", "--quiet", "--template=", "--initial-branch=main"]);
  yield* git(["add", "--all", "--force", "--", "."]);
  yield* git([
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    `base: ${input.pluginId}@${input.version} ${input.digest}`,
  ]);
  return snapshot.directory;
});
