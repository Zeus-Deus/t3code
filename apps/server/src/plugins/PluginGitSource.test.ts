import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Runner from "../processRunner.ts";
import * as Git from "./PluginGitSource.ts";

const output = (stdout: string): Runner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.effect(
  "pins HTTPS source revisions and disables scripts, local transport, prompts, and recursive submodules",
  () =>
    Effect.gen(function* () {
      const calls: Array<Runner.ProcessRunInput> = [];
      const commit = "a".repeat(40);
      const git = yield* Git.PluginGitSource.pipe(
        Effect.provide(
          Git.layer.pipe(
            Layer.provide(
              Layer.succeed(Runner.ProcessRunner, {
                run: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return output(input.args.includes("rev-parse") ? commit : "");
                  }),
              }),
            ),
          ),
        ),
      );
      const staged = yield* git.checkout({
        kind: "git",
        url: "https://plugins.example/workflow.git",
        ref: "release/one",
      });
      expect(staged.source.ref).toBe(commit);
      expect(calls.map((call) => call.args.slice(8))).toEqual([
        ["init", "--quiet", "--template="],
        [
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          "https://plugins.example/workflow.git",
          "release/one",
        ],
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        ["checkout", "--quiet", "--detach", commit, "--"],
      ]);
      expect(
        calls.every(
          (call) =>
            call.args.slice(0, 8).join(" ").includes("core.hooksPath=/dev/null") &&
            call.args.includes("protocol.ext.allow=never") &&
            call.env?.GIT_TERMINAL_PROMPT === "0" &&
            call.env.GIT_CONFIG_NOSYSTEM === "1",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rejects credentialed and non-HTTPS sources before any process starts", () =>
  Effect.gen(function* () {
    let calls = 0;
    const layer = Git.layer.pipe(
      Layer.provide(
        Layer.succeed(Runner.ProcessRunner, {
          run: () =>
            Effect.sync(() => {
              calls++;
              return output("");
            }),
        }),
      ),
    );
    const git = yield* Git.PluginGitSource.pipe(Effect.provide(layer));
    for (const url of [
      "file:///tmp/package",
      "ssh://plugins.example/repo",
      "https://token@plugins.example/repo",
      "https://plugins.example/repo?token=secret",
    ])
      expect(
        (yield* git.checkout({ kind: "git", url }).pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("invalid_source");
    expect(
      (yield* git
        .checkout({ kind: "git", url: "https://plugins.example/repo", ref: "--upload-pack=attack" })
        .pipe(Effect.flip, Effect.orDie)).reason,
    ).toBe("invalid_source");
    expect(calls).toBe(0);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refuses a fetched revision that does not resolve to an immutable commit", () =>
  Effect.gen(function* () {
    const git = yield* Git.PluginGitSource;
    expect(
      (yield* git
        .checkout({ kind: "git", url: "https://plugins.example/repo" })
        .pipe(Effect.flip, Effect.orDie)).reason,
    ).toBe("invalid_source");
  }).pipe(
    Effect.provide(
      Git.layer.pipe(
        Layer.provide(
          Layer.succeed(Runner.ProcessRunner, {
            run: () => Effect.succeed(output("untrusted revision")),
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
