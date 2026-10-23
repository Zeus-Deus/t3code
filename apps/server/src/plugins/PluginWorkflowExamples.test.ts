// @effect-diagnostics nodeBuiltinImport:off -- these fixtures execute the shipped external ESM packages in real Node workers.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  MAX_PLUGIN_TREE_BYTES,
  MAX_PLUGIN_TREE_NODES,
  PluginError,
  PluginManifest,
  PluginModelsListInput,
  PluginProjectsListInput,
  PluginThreadCreateInput,
  PluginThreadMetadata,
  PluginThreadMetadataInput,
  PluginThreadsListInput,
  PluginTreeSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Supervisor from "./PluginSupervisor.ts";
import { inspectPluginSource } from "./pluginSource.ts";

const root = NodePath.resolve(import.meta.dirname, "../../../../examples/plugins");
const source = Schema.decodeUnknownSync(PluginThreadMetadata)({
  id: "source:/one",
  projectId: "project:/one",
  title: "Source",
  modelSelection: { instanceId: "codex", model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "source:/one" },
});
const Selection = Schema.Struct({ planId: Schema.String });
const View = Schema.Struct({
  plan: Schema.Struct({
    id: Schema.String,
    tasks: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        prompt: Schema.String,
        launch: Schema.Struct({
          state: Schema.String,
          threadId: Schema.optionalKey(Schema.String),
          diagnostic: Schema.optionalKey(Schema.String),
        }),
      }),
    ),
  }),
});
const keyInput = Schema.Struct({ key: Schema.String });
const setInput = Schema.Struct({ key: Schema.String, value: Schema.Json });
const topicsInput = Schema.Struct({ topics: Schema.Array(Schema.String) });
const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const decodeView = Schema.decodeUnknownSync(View);
const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeLimits = Schema.decodeUnknownSync(
  Schema.Struct({ TREE_LIMITS: Schema.Struct({ nodes: Schema.Number, bytes: Schema.Number }) }),
);
const decodeKey = Schema.decodeUnknownSync(keyInput);
const decodeSet = Schema.decodeUnknownSync(setInput);
const decodeTopics = Schema.decodeUnknownSync(topicsInput);
const decodeProjects = Schema.decodeUnknownSync(PluginProjectsListInput);
const decodeThreads = Schema.decodeUnknownSync(PluginThreadsListInput);
const decodeMetadata = Schema.decodeUnknownSync(PluginThreadMetadataInput);
const decodeTree = Schema.decodeUnknownSync(PluginTreeSnapshot);
const decodeModels = Schema.decodeUnknownSync(PluginModelsListInput);
const decodeCreate = Schema.decodeUnknownSync(PluginThreadCreateInput);
const decodeSelection = Schema.decodeUnknownSync(Selection);
const forbidden = () =>
  new PluginError({ reason: "permission_denied", message: "Fixture authority revoked." });

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Supervisor.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.provideService(Supervisor.PluginRuntimeConfig, {
      selfInvocation: {
        command: process.execPath,
        entrypoint: NodePath.resolve(import.meta.dirname, "../bin.ts"),
      },
      startupTimeoutMs: 10000,
      invocationTimeoutMs: 10000,
      stopGraceMs: 500,
      restartBackoffMs: 0,
      maxFailures: 3,
    }),
    Effect.provide(NodeServices.layer),
  );

const fixture = Effect.fn("WorkflowExamplesTest.fixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = NodePath.join(root, name);
  const manifest = decodeManifest(
    JSON.parse(yield* fs.readFileString(NodePath.join(directory, "t3-plugin.json"))),
  );
  const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-example-" });
  const base: Supervisor.PluginExecutionInput = {
    installationId: `example-${name}`,
    generation: "one",
    directory,
    entry: manifest.entry,
    dataDirectory,
    handler: "action:propose",
    operationId: "proposal",
    capabilities: [...manifest.capabilities, ...(manifest.optionalCapabilities ?? [])],
    caller: { kind: "agent", threadId: source.id },
    context: { threadId: source.id, projectId: source.projectId },
  };
  return { manifest, base };
});

it.live(
  "publishes a bounded native project tree using only real worker metadata/settings SDK calls",
  () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.PluginSupervisor;
        const { manifest, base } = yield* fixture("projects-tree");
        expect(manifest.capabilities).not.toContain("ui");
        expect((yield* inspectPluginSource(base.directory)).manifest.id).toBe(
          "examples.projects-tree",
        );
        const module = yield* Effect.promise(
          () => import(NodeURL.pathToFileURL(NodePath.join(base.directory, "tree.mjs")).href),
        );
        const limits = decodeLimits(module).TREE_LIMITS;
        expect(limits.nodes).toBeLessThanOrEqual(MAX_PLUGIN_TREE_NODES);
        expect(limits.bytes).toBeLessThanOrEqual(MAX_PLUGIN_TREE_BYTES);
        const calls: string[] = [];
        const host: Supervisor.PluginHostCall = (method, input) =>
          Effect.sync(() => {
            calls.push(method);
            if (method === "settings.get") {
              const { key } = decodeKey(input);
              expect(["emptyProjects", "quietAfterDays"]).toContain(key);
              return null;
            }
            if (method === "projects.list") {
              decodeProjects(input);
              return {
                projects: [
                  {
                    id: source.projectId,
                    title: "Project",
                    workspaceRoot: "/fixture",
                    createdAt: source.createdAt,
                    updatedAt: source.updatedAt,
                  },
                ],
                nextCursor: null,
              };
            }
            if (method === "threads.list") {
              expect(decodeThreads(input).projectId).toBe(source.projectId);
              return { threads: [source], nextCursor: null };
            }
            throw new Error(`Unexpected host method ${method}`);
          });
        const output = yield* supervisor.invoke(
          { ...base, caller: { kind: "client" }, handler: "tree:projects" },
          host,
        );
        const snapshot = decodeTree(output.data);
        expect(snapshot.nodes).toEqual([
          expect.objectContaining({ kind: "project", projectId: source.projectId }),
          expect.objectContaining({ kind: "thread", threadId: source.id }),
        ]);
        expect(calls).toEqual(["settings.get", "settings.get", "projects.list", "threads.list"]);
        const revoked = yield* supervisor
          .invoke({ ...base, handler: "tree:projects" }, () => Effect.fail(forbidden()))
          .pipe(Effect.flip);
        expect(revoked.message).toBe("Fixture authority revoked.");
      }),
    ),
);

// The runtime and ESM SDK are real; storage, grants, metadata, models, and creation
// below are enforcing fixtures, not a core-domain installation or Git/worktree launch.
it.live(
  "keeps immutable proposals, human launch requests, partial uncertainty and equal-op cross-client replay safe in the supervisor",
  () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.PluginSupervisor;
        const { base } = yield* fixture("task-launcher");
        const storage: Record<string, unknown> = {};
        const metadata = new Map([[source.id, source]]);
        const creates: PluginThreadCreateInput[] = [];
        let revoked = false;
        let loseResponse = false;
        const host: Supervisor.PluginHostCall = (method, input) =>
          Effect.gen(function* () {
            if (method === "threads.metadata") {
              const { threadId } = decodeMetadata(input);
              const value = metadata.get(threadId);
              if (revoked || !value) return yield* forbidden();
              return value;
            }
            if (method === "storage.get")
              return structuredClone(storage[decodeKey(input).key] ?? null);
            if (method === "storage.set") {
              const { key, value } = decodeSet(input);
              expect(key).toMatch(keyPattern);
              expect(
                Buffer.byteLength(JSON.stringify({ ...storage, [key]: value })),
              ).toBeLessThanOrEqual(1000000);
              storage[key] = structuredClone(value);
              return null;
            }
            if (method === "ui.invalidate") {
              expect(decodeTopics(input).topics).toEqual([
                "view:launcher",
                "view:tasks",
                "status:tasks",
              ]);
              return null;
            }
            if (method === "models.list") {
              expect(decodeModels(input).projectId).toBe(source.projectId);
              return { models: [], nextCursor: null };
            }
            if (method === "threads.create") {
              const request = decodeCreate(input);
              expect(JSON.stringify(storage)).toContain('"pending"');
              expect(request.projectId).toBe(source.projectId);
              creates.push(request);
              const threadId = ThreadId.make(`child-${creates.length}`);
              metadata.set(threadId, {
                ...source,
                id: threadId,
                launchedFrom: { threadId: source.id },
              });
              if (loseResponse)
                return yield* new PluginError({
                  reason: "operation_failed",
                  message: "Fixture response lost after acceptance.",
                });
              return { threadId };
            }
            throw new Error(`Unexpected host method ${method}`);
          });
        const proposal = yield* supervisor.invoke(
          {
            ...base,
            input: {
              tasks: [
                { title: "One", prompt: "Do one" },
                { title: "Two", prompt: "Do two" },
              ],
            },
          },
          host,
        );
        expect(proposal.message).toBe("Proposed 2 tasks. Review before starting.");
        const selection = decodeSelection(proposal.card?.data);
        expect(proposal.card?.data).toEqual(selection);
        const client = { ...base, caller: { kind: "client" as const }, operationId: "click-one" };
        const view = decodeView(
          (yield* supervisor.invoke(
            { ...client, handler: "view:launcher:read", input: selection },
            host,
          )).data,
        );
        const first = {
          ...selection,
          taskId: view.plan.tasks[0]!.id,
          workspaceStrategy: { type: "worktree", baseRef: "main", branch: "one" },
          runtimeMode: "auto",
          interactionMode: "plan",
        };
        const started = yield* supervisor.invoke(
          { ...client, handler: "view:launcher:start", input: first },
          host,
        );
        expect(decodeView(started.data).plan.tasks[0]!.launch.state).toBe("started");
        expect(creates[0]).toMatchObject({
          title: "One",
          text: "Do one",
          runtimeMode: "auto",
          interactionMode: "plan",
          workspaceStrategy: { type: "worktree", baseRef: "main", branch: "one" },
        });
        loseResponse = true;
        const second = { ...selection, taskId: view.plan.tasks[1]!.id };
        const lost = yield* supervisor.invoke(
          { ...client, handler: "view:launcher:start", input: second },
          host,
        );
        expect(decodeView(lost.data).plan.tasks.map((t) => t.launch.state)).toEqual([
          "started",
          "uncertain",
        ]);
        yield* supervisor.stop(base.installationId);
        const restarted = { ...client, generation: "two" };
        const replay = yield* supervisor.invoke(
          { ...restarted, handler: "view:tasks:start", input: second },
          host,
        );
        expect(decodeView(replay.data).plan.tasks[1]!.launch.state).toBe("uncertain");
        expect(creates).toHaveLength(2);
        const oldSuccess = yield* supervisor.invoke(
          {
            ...restarted,
            operationId: "another-client",
            handler: "view:tasks:start",
            input: first,
          },
          host,
        );
        expect(decodeView(oldSuccess.data).plan.tasks[0]!.launch.threadId).toBe("child-1");
        expect(creates).toHaveLength(2);
        revoked = true;
        const denied = yield* supervisor
          .invoke({ ...restarted, handler: "view:tasks:read", input: selection }, host)
          .pipe(Effect.flip);
        expect(denied.message).toBe("Fixture authority revoked.");
      }),
    ),
);

it.live(
  "does not redispatch after cancellation of a held create response and worker replacement",
  () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* Supervisor.PluginSupervisor;
        const { base } = yield* fixture("task-launcher");
        const storage: Record<string, unknown> = {};
        const accepted = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<void>();
        let creates = 0;
        const host: Supervisor.PluginHostCall = (method, input) => {
          if (method === "threads.create")
            return Effect.gen(function* () {
              decodeCreate(input);
              expect(JSON.stringify(storage)).toContain('"pending"');
              creates++;
              yield* Deferred.succeed(accepted, undefined);
              return yield* Effect.never;
            }).pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)));
          return Effect.sync(() => {
            if (method === "threads.metadata") {
              expect(decodeMetadata(input).threadId).toBe(source.id);
              return source;
            }
            if (method === "storage.get")
              return structuredClone(storage[decodeKey(input).key] ?? null);
            if (method === "storage.set") {
              const { key, value } = decodeSet(input);
              expect(key).toMatch(keyPattern);
              storage[key] = structuredClone(value);
              return null;
            }
            if (method === "ui.invalidate") return null;
            throw new Error(`Unexpected host method ${method}`);
          });
        };
        const proposed = yield* supervisor.invoke(
          {
            ...base,
            input: {
              tasks: [
                { title: "Held", prompt: "Hold core response" },
                { title: "Untouched", prompt: "Do not dispatch after cancellation" },
              ],
            },
          },
          host,
        );
        const selection = decodeSelection(proposed.card?.data);
        const client = {
          ...base,
          caller: { kind: "client" as const },
          operationId: "same-operation",
        };
        const view = decodeView(
          (yield* supervisor.invoke(
            { ...client, handler: "view:tasks:read", input: selection },
            host,
          )).data,
        );
        const input = { ...selection, taskId: view.plan.tasks[0]!.id };
        const running = yield* supervisor
          .invoke(
            {
              ...client,
              handler: "view:tasks:startAll",
              input: {
                ...selection,
                choices: view.plan.tasks.map((task) => ({ taskId: task.id })),
              },
            },
            host,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(accepted);
        yield* Fiber.interrupt(running);
        yield* Deferred.await(cancelled);
        yield* supervisor.stop(base.installationId);
        const result = yield* supervisor.invoke(
          { ...client, generation: "two", handler: "view:tasks:start", input },
          host,
        );
        expect(decodeView(result.data).plan.tasks[0]!.launch).toMatchObject({
          state: "uncertain",
          diagnostic: expect.stringContaining("Inspect threads"),
        });
        expect(decodeView(result.data).plan.tasks[1]!.launch.state).toBe("proposed");
        expect(creates).toBe(1);
      }),
    ),
);
