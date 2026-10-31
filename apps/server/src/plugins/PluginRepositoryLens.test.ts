// @effect-diagnostics nodeBuiltinImport:off -- fixtures exercise the external ESM plugin with real Git and Node children.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PluginManifest, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  PluginActionContext,
  PluginContext,
  PluginHandler,
  PluginModule,
  PluginSettingValue,
} from "../../../../packages/plugin-sdk/src/index.ts";
import * as Supervisor from "./PluginSupervisor.ts";

const directory = NodePath.resolve(import.meta.dirname, "fixtures/consumers/repository-lens");
const Snapshot = Schema.Struct({
  repositoryPath: Schema.String,
  branch: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      indexStatus: Schema.String,
      worktreeStatus: Schema.String,
      originalPath: Schema.optionalKey(Schema.String),
    }),
  ),
  commits: Schema.Array(Schema.Struct({ hash: Schema.String, subject: Schema.String })),
  truncated: Schema.Boolean,
});
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);
const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeDiff = Schema.decodeUnknownSync(
  Schema.Struct({
    path: Schema.String,
    diff: Schema.String,
    truncated: Schema.Boolean,
  }),
);
const decodeModule = Schema.decodeUnknownSync(
  Schema.declare(
    (input): input is PluginModule =>
      typeof input === "object" &&
      input !== null &&
      "activate" in input &&
      typeof input.activate === "function",
  ),
);

const git = Effect.fn("RepositoryLensTest.git")((cwd: string, args: readonly string[]) =>
  Effect.tryPromise(
    () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "git",
          [
            "--no-optional-locks",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "user.name=Repository Lens Test",
            "-c",
            "user.email=lens@example.test",
            ...args,
          ],
          { cwd, encoding: "utf8" },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      }),
  ),
);

const loadPlugin = Effect.fn("RepositoryLensTest.loadPlugin")((initialPath: string) =>
  Effect.tryPromise(async () => {
    const module = decodeModule(
      await import(NodeURL.pathToFileURL(NodePath.join(directory, "plugin.mjs")).href),
    );
    const handlers = new Map<string, PluginHandler>();
    let repositoryPath: PluginSettingValue | null = initialPath;
    const unexpected = async () => {
      throw new Error("Repository Lens must not call mutating or thread host APIs.");
    };
    const context: PluginContext = {
      apiVersion: 1,
      dataDirectory: directory,
      capabilities: ["ui", "settings"],
      signal: new AbortController().signal,
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
      log: () => {},
      settings: {
        get: async (key) => {
          expect(key).toBe("repositoryPath");
          return repositoryPath;
        },
      },
      storage: { get: unexpected, set: unexpected, delete: unexpected },
      threads: {
        adopt: async () => {
          throw new Error("Not used by repository lens");
        },
        unarchive: async () => {
          throw new Error("Not used by repository lens");
        },
        read: unexpected,
        send: unexpected,
        create: unexpected,
        list: unexpected,
        metadata: unexpected,
      },
      projects: { list: unexpected, requestAccess: unexpected },
      models: { list: unexpected },
      trees: {
        register: () => {
          throw new Error("Unexpected tree registration.");
        },
      },
      ui: { invalidate: unexpected },
      events: {
        onRunFinalized: () => {
          throw new Error("Unexpected event subscription.");
        },
      },
    };
    await module.activate(context);
    return {
      setRepositoryPath: (value: PluginSettingValue | null) => {
        repositoryPath = value;
      },
      invoke: async (
        name: string,
        input?: unknown,
        context?: PluginActionContext,
        signal = new AbortController().signal,
      ) => {
        const handler = handlers.get(name);
        if (!handler) throw new Error(`Missing handler ${name}`);
        return (
          (await handler(input, {
            signal,
            operationId: "lens-test",
            caller: { kind: "client" },
            ...(context ? { context } : {}),
          })) ?? {}
        );
      },
    };
  }),
);

const fixture = Effect.fn("RepositoryLensTest.fixture")(function* (committed = true) {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-repository-lens space-" });
  const write = (path: string, text: string) => fs.writeFileString(NodePath.join(cwd, path), text);
  const run = (args: readonly string[]) => git(cwd, args);
  yield* run(["init", "--initial-branch=main", "--template="]);
  if (committed) {
    for (const [path, text] of [
      ["tracked.txt", "base\n"],
      ["old name.txt", "rename me\n"],
      ["magic[1].txt", "literal base\n"],
      ["magic1.txt", "other base\n"],
    ] as const)
      yield* write(path, text);
    yield* run(["add", "--all"]);
    yield* run(["commit", "-m", "Initial commit"]);
  }
  return { cwd, fs, write, run, plugin: yield* loadPlugin(cwd) };
});

const inspect = Effect.fn("RepositoryLensTest.inspect")(
  (plugin: Effect.Success<ReturnType<typeof loadPlugin>>) =>
    Effect.tryPromise(async () =>
      decodeSnapshot((await plugin.invoke("view:repository:inspect")).data),
    ),
);
const diff = Effect.fn("RepositoryLensTest.diff")(
  (plugin: Effect.Success<ReturnType<typeof loadPlugin>>, path: string) =>
    Effect.tryPromise(async () =>
      decodeDiff((await plugin.invoke("view:repository:diff", { path })).data),
    ),
);

const captureFiles = async (root: string): Promise<ReadonlyArray<unknown>> => {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = NodePath.join(root, entry.name);
        if (entry.isDirectory()) return [entry.name, await captureFiles(path)];
        const stat = await NodeFSP.stat(path);
        return [entry.name, stat.mtimeMs, (await NodeFSP.readFile(path)).toString("base64")];
      }),
  );
};

it.live(
  "declares the Repository Lens contribution and returns a clean snapshot with the five newest commits",
  () =>
    Effect.gen(function* () {
      const { fs, cwd, run, plugin } = yield* fixture();
      const manifest = decodeManifest(
        JSON.parse(yield* fs.readFileString(NodePath.join(directory, "t3-plugin.json"))),
      );
      expect(manifest).toMatchObject({
        id: "examples.repository-lens",
        version: "1.0.0",
        apiVersion: 1,
        capabilities: ["ui", "settings"],
      });
      expect(manifest.actions).toEqual([
        {
          id: "open-inspector",
          title: "Open Repository Lens",
          placements: ["thread-menu"],
        },
        expect.objectContaining({
          id: "inspect",
          placements: ["palette", "thread-menu"],
          agentCallable: true,
        }),
        {
          id: "insert-review",
          title: "Insert repository review request",
          description: "Add a review request to this thread's composer without sending it.",
          placements: ["thread-menu"],
        },
      ]);
      expect(manifest.views).toEqual([
        { id: "repository", title: "Repository Lens", entry: "view.html", placement: "side-panel" },
      ]);
      expect(manifest.settings).toEqual([
        expect.objectContaining({ key: "repositoryPath", type: "string", default: "" }),
      ]);
      for (let index = 1; index <= 5; index++)
        yield* run(["commit", "--allow-empty", "-m", `Commit ${index}`]);
      const snapshot = yield* inspect(plugin);
      expect(snapshot).toMatchObject({
        repositoryPath: cwd,
        branch: "main",
        files: [],
        truncated: false,
      });
      expect(snapshot.commits.map((commit) => commit.subject)).toEqual([
        "Commit 5",
        "Commit 4",
        "Commit 3",
        "Commit 2",
        "Commit 1",
      ]);
      expect(snapshot.commits.every((commit) => /^[a-f0-9]{40,64}$/.test(commit.hash))).toBe(true);
      const action = yield* Effect.tryPromise(() => plugin.invoke("action:inspect"));
      expect(action.data).toEqual(snapshot);
      expect(action.message).toContain("Branch main: 0 changed files");
      expect(yield* Effect.tryPromise(() => plugin.invoke("action:open-inspector"))).toEqual({
        intents: [{ type: "view.open", viewId: "repository" }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "preserves staged, unstaged, untracked, renamed, space, and newline paths from real Git status",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const { write, run, plugin } = yield* fixture();
      yield* write("tracked.txt", "base\nstaged\n");
      yield* run(["add", "--", "tracked.txt"]);
      yield* write("tracked.txt", "base\nstaged\nunstaged\n");
      yield* run(["mv", "old name.txt", "new name.txt"]);
      yield* write("new name.txt", "rename me\nunstaged rename edit\n");
      yield* write("untracked space.txt", "not read\n");
      yield* write("magic1.txt", "unstaged only\n");
      if (platform !== "win32") yield* write("line\nbreak.txt", "not read either\n");
      const snapshot = yield* inspect(plugin);
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.files).toEqual(
        expect.arrayContaining([
          { path: "tracked.txt", indexStatus: "M", worktreeStatus: "M" },
          {
            path: "new name.txt",
            indexStatus: "R",
            worktreeStatus: "M",
            originalPath: "old name.txt",
          },
          { path: "untracked space.txt", indexStatus: "?", worktreeStatus: "?" },
          { path: "magic1.txt", indexStatus: " ", worktreeStatus: "M" },
        ]),
      );
      if (platform !== "win32")
        expect(snapshot.files).toContainEqual({
          path: "line\nbreak.txt",
          indexStatus: "?",
          worktreeStatus: "?",
        });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "returns only the selected file's staged and unstaged diffs and never reads untracked contents",
  () =>
    Effect.gen(function* () {
      const { write, run, plugin } = yield* fixture();
      yield* write("tracked.txt", "base\nstaged change\n");
      yield* run(["add", "--", "tracked.txt"]);
      yield* write("tracked.txt", "base\nstaged change\nunstaged change\n");
      yield* write("untracked space.txt", "UNTRACKED PRIVATE CONTENT\n");
      const result = yield* diff(plugin, "tracked.txt");
      expect(result).toMatchObject({ path: "tracked.txt", truncated: false });
      expect(result.diff).toContain("Staged changes\n");
      expect(result.diff).toContain("+staged change");
      expect(result.diff).toContain("Unstaged changes\n");
      expect(result.diff).toContain("+unstaged change");
      const untracked = yield* diff(plugin, "untracked space.txt");
      expect(untracked.diff).toContain("Untracked file");
      expect(untracked.diff).not.toContain("UNTRACKED PRIVATE CONTENT");
      expect(untracked.truncated).toBe(false);
      yield* run(["mv", "old name.txt", "new name.txt"]);
      expect((yield* diff(plugin, "new name.txt")).diff).toContain("rename me");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "treats changed filenames literally and rejects arbitrary, stale, and pathspec diff input",
  () =>
    Effect.gen(function* () {
      const { cwd, write, run, plugin } = yield* fixture();
      yield* write("magic[1].txt", "literal selected change\n");
      yield* write("magic1.txt", "PRIVATE OTHER FILE CHANGE\n");
      const selected = yield* diff(plugin, "magic[1].txt");
      expect(selected.diff).toContain("literal selected change");
      expect(selected.diff).not.toContain("PRIVATE OTHER FILE CHANGE");
      for (const path of [
        "../outside.txt",
        NodePath.join(cwd, "magic1.txt"),
        ":(glob)*",
        ".git/config",
        "tracked.txt",
        "magic[1].txt\0",
        "",
        null,
      ]) {
        yield* Effect.promise(() =>
          expect(plugin.invoke("view:repository:diff", { path })).rejects.toThrow(
            "current changed-file list",
          ),
        );
      }
      yield* inspect(plugin);
      yield* run(["restore", "--", "magic[1].txt"]);
      yield* Effect.promise(() =>
        expect(plugin.invoke("view:repository:diff", { path: "magic[1].txt" })).rejects.toThrow(
          "current changed-file list",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "throws actionable errors for empty, relative, nonexistent, non-directory, and non-repository configuration",
  () =>
    Effect.gen(function* () {
      const { cwd, fs, plugin } = yield* fixture();
      const plain = yield* fs.makeTempDirectoryScoped({ prefix: "t3-not-a-repository-" });
      for (const setting of [
        "",
        " ",
        null,
        false,
        12,
        "relative/repo",
        `${cwd}\0`,
        NodePath.join(cwd, "missing"),
        NodePath.join(cwd, "tracked.txt"),
        plain,
      ]) {
        plugin.setRepositoryPath(setting);
        yield* Effect.promise(() =>
          expect(plugin.invoke("view:repository:inspect")).rejects.toThrow(
            /Repository path|repository path/,
          ),
        );
      }
      plugin.setRepositoryPath(NodePath.join(cwd, ".git"));
      yield* Effect.promise(() =>
        expect(plugin.invoke("view:repository:inspect")).rejects.toThrow("work tree"),
      );
      plugin.setRepositoryPath(cwd);
      expect((yield* inspect(plugin)).branch).toBe("main");
      const cancelled = AbortSignal.abort(new Error("Inspection cancelled by caller"));
      yield* Effect.promise(() =>
        expect(
          plugin.invoke("view:repository:inspect", undefined, undefined, cancelled),
        ).rejects.toThrow("Inspection cancelled by caller"),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("supports unborn and detached branches and reads updated settings on each invocation", () =>
  Effect.gen(function* () {
    const unborn = yield* fixture(false);
    expect(yield* inspect(unborn.plugin)).toEqual({
      repositoryPath: unborn.cwd,
      branch: "main",
      files: [],
      commits: [],
      truncated: false,
    });
    const detached = yield* fixture();
    yield* detached.run(["checkout", "--detach"]);
    unborn.plugin.setRepositoryPath(detached.cwd);
    expect((yield* inspect(unborn.plugin)).branch).toBe("(detached HEAD)");
    const fs = yield* FileSystem.FileSystem;
    const nested = NodePath.join(detached.cwd, "nested space");
    yield* fs.makeDirectory(nested);
    unborn.plugin.setRepositoryPath(nested);
    expect((yield* inspect(unborn.plugin)).repositoryPath).toBe(detached.cwd);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("bounds large status and Unicode diff output and reports truncation", () =>
  Effect.gen(function* () {
    const { cwd, write, plugin } = yield* fixture();
    const names = Array.from(
      { length: 320 },
      (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(120)}.txt`,
    );
    yield* Effect.forEach(names, (path) => write(path, "untracked\n"), { concurrency: 8 });
    yield* write("tracked.txt", "changed 🦊\n".repeat(8000));
    const snapshot = yield* inspect(plugin);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.files.length).toBeGreaterThan(0);
    expect(snapshot.files.length).toBeLessThan(names.length);
    expect(
      snapshot.files.every((file) => file.path === "tracked.txt" || names.includes(file.path)),
    ).toBe(true);
    const result = yield* diff(plugin, "tracked.txt");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(16 * 1024);
    expect(result.diff).toContain("changed 🦊");
    expect(result.diff).not.toContain("�");
    expect(snapshot.repositoryPath).toBe(cwd);
    const review = yield* Effect.tryPromise(() =>
      plugin.invoke("view:repository:insert-review", undefined, { threadId: "thread-1" }),
    );
    const prompt = review.intents?.[0];
    if (prompt?.type !== "composer.insert") throw new Error("Missing composer insert");
    expect(Buffer.byteLength(prompt.text)).toBeLessThan(16 * 1024);
    expect(prompt.text).toContain("File list is partial");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "inserts a bounded review prompt for the configured repository without sending or starting a thread",
  () =>
    Effect.gen(function* () {
      const { cwd, write, run, plugin } = yield* fixture();
      yield* run(["mv", "old name.txt", "new name.txt"]);
      yield* write("untracked space.txt", "private content\n");
      for (const handler of ["view:repository:insert-review", "action:insert-review"]) {
        yield* Effect.promise(() =>
          expect(plugin.invoke(handler)).rejects.toThrow("from a thread"),
        );
      }
      const result = yield* Effect.tryPromise(() =>
        plugin.invoke("view:repository:insert-review", undefined, { threadId: "thread-1" }),
      );
      expect(result.intents).toEqual([
        {
          type: "composer.insert",
          text: expect.stringContaining(`Repository: ${JSON.stringify(cwd)}`),
        },
      ]);
      const prompt = result.intents?.[0];
      expect(prompt?.type).toBe("composer.insert");
      if (prompt?.type !== "composer.insert") throw new Error("Missing composer insert");
      expect(prompt.text).toContain('Branch: "main"');
      expect(prompt.text).toContain('[R ] "new name.txt" (from "old name.txt")');
      expect(prompt.text).toContain('[??] "untracked space.txt"');
      expect(prompt.text).not.toContain("private content");
      expect(Buffer.byteLength(prompt.text)).toBeLessThan(16 * 1024);
      expect(
        yield* Effect.tryPromise(() =>
          plugin.invoke("action:insert-review", undefined, { threadId: "thread-1" }),
        ),
      ).toEqual(result);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "leaves worktree files and every Git metadata file unchanged during inspection, diff, and review insertion",
  () =>
    Effect.gen(function* () {
      const { cwd, write, run, plugin } = yield* fixture();
      yield* write("tracked.txt", "staged\n");
      yield* run(["add", "tracked.txt"]);
      yield* write("tracked.txt", "staged\nunstaged\n");
      yield* write("untracked space.txt", "private content\n");
      yield* write(".gitattributes", "*.txt diff=lens\n");
      for (const [key, value] of [
        ["core.fsmonitor", "must-not-run-repository-lens-fsmonitor"],
        ["diff.external", "must-not-run-repository-lens-diff"],
        ["diff.lens.textconv", "must-not-run-repository-lens-textconv"],
      ] as const)
        yield* run(["config", key, value]);
      const before = yield* Effect.promise(() => captureFiles(cwd));
      yield* inspect(plugin);
      yield* diff(plugin, "tracked.txt");
      yield* diff(plugin, "untracked space.txt");
      yield* Effect.tryPromise(() => plugin.invoke("action:inspect"));
      yield* Effect.tryPromise(() =>
        plugin.invoke("view:repository:insert-review", undefined, { threadId: "thread-1" }),
      );
      yield* Effect.tryPromise(() =>
        plugin.invoke("action:insert-review", undefined, { threadId: "thread-1" }),
      );
      expect(yield* Effect.promise(() => captureFiles(cwd))).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("runs the dependency-free ESM backend and its helper in the real plugin supervisor", () =>
  Effect.gen(function* () {
    const { cwd, write } = yield* fixture();
    yield* write("tracked.txt", "worker diff\n");
    const supervisor = yield* Supervisor.PluginSupervisor;
    const host: Supervisor.PluginHostCall = (method, input) =>
      Effect.sync(() => {
        expect(method).toBe("settings.get");
        expect(input).toEqual({ key: "repositoryPath" });
        return cwd;
      });
    const base = {
      installationId: "example-repository-lens",
      generation: "one",
      directory,
      entry: "plugin.mjs",
      dataDirectory: directory,
      caller: { kind: "client" as const },
      operationId: "inspect-1",
    };
    const snapshot = yield* supervisor.invoke({ ...base, handler: "action:inspect" }, host);
    expect(decodeSnapshot(snapshot.data)).toMatchObject({
      repositoryPath: cwd,
      branch: "main",
      files: [{ path: "tracked.txt", indexStatus: " ", worktreeStatus: "M" }],
      truncated: false,
    });
    const result = yield* supervisor.invoke(
      {
        ...base,
        operationId: "diff-1",
        handler: "view:repository:diff",
        input: { path: "tracked.txt" },
      },
      host,
    );
    expect(decodeDiff(result.data).diff).toContain("+worker diff");
    for (const handler of ["view:repository:insert-review", "action:insert-review"]) {
      const review = yield* supervisor.invoke(
        {
          ...base,
          operationId: handler,
          handler,
          context: { threadId: ThreadId.make("thread-1") },
        },
        host,
      );
      expect(review.intents).toEqual([
        { type: "composer.insert", text: expect.stringContaining('Branch: "main"') },
      ]);
    }
    const invalidRepository = yield* supervisor
      .invoke({ ...base, handler: "view:repository:inspect" }, () => Effect.succeed(""))
      .pipe(Effect.flip);
    expect(invalidRepository.reason).toBe("operation_failed");
    expect(invalidRepository.message).toBe(
      "Set Repository path in Repository Lens settings to an absolute Git working-tree path on this server.",
    );
    expect(Supervisor.isPluginWorkerFault(invalidRepository)).toBe(false);
    const recovered = yield* supervisor.invoke({ ...base, handler: "action:inspect" }, host);
    expect(decodeSnapshot(recovered.data).repositoryPath).toBe(cwd);
  }).pipe(
    Effect.scoped,
    Effect.provide(Supervisor.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.provideService(Supervisor.PluginRuntimeConfig, {
      selfInvocation: {
        command: process.execPath,
        entrypoint: NodePath.resolve(import.meta.dirname, "../bin.ts"),
      },
      startupTimeoutMs: 10_000,
      invocationTimeoutMs: 10_000,
      stopGraceMs: 500,
      restartBackoffMs: 0,
      maxFailures: 3,
    }),
    Effect.provide(NodeServices.layer),
  ),
);
