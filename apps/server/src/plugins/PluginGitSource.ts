import { PluginError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ProcessRunner from "../processRunner.ts";

const isPluginError = Schema.is(PluginError);

export class PluginGitSource extends Context.Service<
  PluginGitSource,
  {
    readonly checkout: (source: {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string;
    }) => Effect.Effect<
      {
        readonly directory: string;
        readonly source: { readonly kind: "git"; readonly url: string; readonly ref: string };
      },
      PluginError,
      Scope.Scope
    >;
  }
>()("t3/plugins/PluginGitSource") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const checkout = Effect.fn("PluginGitSource.checkout")(
    function* (source: { readonly kind: "git"; readonly url: string; readonly ref?: string }) {
      const url = yield* Effect.try({
        try: () => new URL(source.url),
        catch: () =>
          new PluginError({
            reason: "invalid_source",
            message: "A valid HTTPS repository URL is required.",
          }),
      });
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (source.ref !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(source.ref))
      )
        return yield* new PluginError({
          reason: "invalid_source",
          message: "Use an HTTPS repository without embedded credentials and a valid revision.",
        });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-git-" });
      const git = Effect.fn("PluginGitSource.git")(function* (args: ReadonlyArray<string>) {
        const result = yield* runner.run({
          command: "git",
          args: [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.file.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "submodule.recurse=false",
            ...args,
          ],
          cwd: directory,
          env: {
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_COUNT: "0",
            GIT_CONFIG_PARAMETERS: "",
            GIT_ASKPASS: "",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_LFS_SKIP_SMUDGE: "1",
          },
          maxOutputBytes: 64_000,
          timeout: "60 seconds",
        });
        if (result.code !== 0 || result.stdoutTruncated || result.stdoutInvalidUtf8)
          return yield* new PluginError({
            reason: "invalid_source",
            message: "The plugin repository could not be fetched at the requested revision.",
          });
        return result.stdout.trim();
      });
      yield* git(["init", "--quiet", "--template="]);
      yield* git([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        url.toString(),
        source.ref ?? "HEAD",
      ]);
      const commit = yield* git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
      if (!/^[a-f0-9]{40,64}$/.test(commit))
        return yield* new PluginError({
          reason: "invalid_source",
          message: "The plugin revision must resolve to an immutable commit.",
        });
      yield* git(["checkout", "--quiet", "--detach", commit, "--"]);
      return { directory, source: { kind: "git" as const, url: source.url, ref: commit } };
    },
    Effect.mapError((error) =>
      isPluginError(error)
        ? error
        : new PluginError({
            reason: "invalid_source",
            message: "The plugin repository could not be staged.",
          }),
    ),
  );
  return PluginGitSource.of({ checkout });
});
export const layer = Layer.effect(PluginGitSource, make);
