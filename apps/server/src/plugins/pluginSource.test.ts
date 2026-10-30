// @effect-diagnostics nodeBuiltinImport:off -- these tests exercise real package snapshot paths.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  inspectPluginSource,
  safePluginPath,
  snapshotPluginSource,
  verifyPluginSnapshot,
} from "./pluginSource.ts";

const manifest = {
  id: "test.plugin",
  name: "Test",
  version: "1.0.0",
  apiVersion: 1,
  entry: "plugin.mjs",
  capabilities: ["storage"],
  actions: [],
  views: [],
  settings: [],
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-source-" });
  const directory = NodePath.join(root, "source");
  const destinationDirectory = NodePath.join(root, "snapshot");
  yield* fs.makeDirectory(directory);
  yield* fs.writeFileString(NodePath.join(directory, "t3-plugin.json"), JSON.stringify(manifest));
  yield* fs.writeFileString(
    NodePath.join(directory, "plugin.mjs"),
    "export function activate() {}",
  );
  return { fs, directory, destinationDirectory };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("plugin package snapshots", () => {
  it.effect("copies exact package bytes without executing activation or install scripts", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "package.json"),
          JSON.stringify({ scripts: { install: "exit 1" } }),
        );
        const inspected = yield* inspectPluginSource(input.directory);
        const snapshot = yield* snapshotPluginSource(input);
        expect(snapshot.digest).toBe(inspected.digest);
        expect(snapshot.manifest).toEqual(manifest);
        yield* verifyPluginSnapshot(snapshot);
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "plugin.mjs"),
          "throw new Error('source changed')",
        );
        expect((yield* inspectPluginSource(input.directory)).digest).not.toBe(snapshot.digest);
        expect((yield* inspectPluginSource(input.destinationDirectory)).digest).toBe(
          snapshot.digest,
        );
      }),
    ),
  );

  it.effect("requires renewed consent after installed bytes change", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        const snapshot = yield* snapshotPluginSource(input);
        yield* input.fs.writeFileString(
          NodePath.join(input.destinationDirectory, "extra.txt"),
          "new bytes",
        );
        const error = yield* verifyPluginSnapshot(snapshot).pipe(Effect.flip);
        expect(error.reason).toBe("changed_source");
      }),
    ),
  );

  it.effect("rejects traversal entries and missing declared view assets", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({ ...manifest, entry: "../outside.mjs" }),
        );
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({
            ...manifest,
            views: [{ id: "board", title: "Board", placement: "page", entry: "board.html" }],
          }),
        );
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        expect(() => safePluginPath(input.directory, "/etc/passwd")).toThrow();
        expect(() => safePluginPath(input.directory, "dir/../plugin.mjs")).toThrow();
        expect(() => safePluginPath(input.directory, "C:\\plugin.mjs")).toThrow();
      }),
    ),
  );

  it.effect("rejects symlink files before reading them", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        yield* input.fs.symlink(
          NodePath.join(input.directory, "plugin.mjs"),
          NodePath.join(input.directory, "linked.mjs"),
        );
        const error = yield* inspectPluginSource(input.directory).pipe(Effect.flip);
        expect(error.reason).toBe("invalid_source");
      }),
    ),
  );

  it.effect(
    "rejects API mismatch, invalid semver, duplicate declarations and secret defaults",
    () =>
      provide(
        Effect.gen(function* () {
          const input = yield* fixture;
          yield* input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({ ...manifest, apiVersion: 2 }),
          );
          expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
            "incompatible",
          );
          yield* input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({ ...manifest, version: "01.0.0" }),
          );
          expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
            "invalid_manifest",
          );
          yield* input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({ ...manifest, capabilities: ["storage", "storage"] }),
          );
          expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
            "invalid_manifest",
          );
          yield* input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({
              ...manifest,
              settings: [{ key: "token", label: "Token", type: "secret", default: "secret" }],
            }),
          );
          expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
            "invalid_manifest",
          );
        }),
      ),
  );

  it.effect("preserves unsupported required capabilities for pre-execution incompatibility", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({ ...manifest, capabilities: ["future.capability"] }),
        );
        const result = yield* inspectPluginSource(input.directory);
        expect(result.manifest.capabilities).toEqual(["future.capability"]);
      }),
    ),
  );

  it.effect(
    "rejects unsupported author placements instead of silently discarding declarations",
    () =>
      provide(
        Effect.gen(function* () {
          const input = yield* fixture;
          yield* input.fs.writeFileString(
            NodePath.join(input.directory, "board.html"),
            "<p>Board</p>",
          );
          for (const declarations of [
            { actions: [{ id: "run", title: "Run", placements: ["palete"] }] },
            { views: [{ id: "board", title: "Board", entry: "board.html", placement: "future" }] },
          ]) {
            yield* input.fs.writeFileString(
              NodePath.join(input.directory, "t3-plugin.json"),
              JSON.stringify({ ...manifest, ...declarations }),
            );
            expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
              "invalid_manifest",
            );
          }
        }),
      ),
  );

  it.effect("accepts a thread status only when it opens a declared side panel", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "view.html"),
          "<p>Panel</p>",
        );
        const write = (threadStatus: unknown, placement = "side-panel") =>
          input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({
              ...manifest,
              capabilities: ["ui"],
              views: [{ id: "panel", title: "Panel", entry: "view.html", placement }],
              threadStatus,
            }),
          );
        yield* write([{ id: "live", title: "Live", viewId: "panel" }]);
        expect((yield* inspectPluginSource(input.directory)).manifest.threadStatus).toEqual([
          { id: "live", title: "Live", viewId: "panel" },
        ]);
        for (const [threadStatus, placement] of [
          [[{ id: "live", title: "Live", viewId: "missing" }], "side-panel"],
          [[{ id: "live", title: "Live", viewId: "panel" }], "page"],
          [
            [
              { id: "live", title: "Live" },
              { id: "live", title: "Again" },
            ],
            "side-panel",
          ],
        ] as const) {
          yield* write(threadStatus, placement);
          const error = yield* inspectPluginSource(input.directory).pipe(Effect.flip);
          expect(error.reason).toBe("invalid_manifest");
        }
      }),
    ),
  );

  it.effect("accepts sidebar views only with their capability and unique names", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        const projects = { id: "projects", title: "Projects", groupBy: "project" };
        const write = (capabilities: unknown, sidebarViews: unknown) =>
          input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({ ...manifest, capabilities, sidebarViews }),
          );
        yield* write(["ui.sidebar-views"], [projects]);
        expect((yield* inspectPluginSource(input.directory)).manifest.sidebarViews).toEqual([
          projects,
        ]);
        for (const [capabilities, sidebarViews] of [
          [["ui"], [projects]],
          [["ui.sidebar-views"], [projects, { ...projects, title: "Again" }]],
        ] as const) {
          yield* write(capabilities, sidebarViews);
          const error = yield* inspectPluginSource(input.directory).pipe(Effect.flip);
          expect(error.reason).toBe("invalid_manifest");
        }
      }),
    ),
  );

  it.effect("never overwrites an existing snapshot", () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        const snapshot = yield* snapshotPluginSource(input);
        yield* input.fs.writeFileString(NodePath.join(input.directory, "plugin.mjs"), "changed");
        expect((yield* snapshotPluginSource(input).pipe(Effect.flip)).reason).toBe(
          "invalid_source",
        );
        expect((yield* inspectPluginSource(input.destinationDirectory)).digest).toBe(
          snapshot.digest,
        );
      }),
    ),
  );
});

it.effect(
  "requires named capabilities and unique declarations for native trees and conversation views",
  () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        const nativeTrees = [{ id: "native", title: "Native" }];
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({ ...manifest, nativeTrees }),
        );
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({
            ...manifest,
            capabilities: ["ui.native-trees"],
            nativeTrees: [...nativeTrees, ...nativeTrees],
          }),
        );
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        yield* input.fs.writeFileString(NodePath.join(input.directory, "view.html"), "<p>Card</p>");
        const views = [
          { id: "card", title: "Card", placement: "conversation", entry: "view.html" },
        ];
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({ ...manifest, views }),
        );
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        const wallpapers = [
          { id: "koi", title: "Koi", placement: "wallpaper", entry: "view.html" },
        ];
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({ ...manifest, views: wallpapers }),
        );
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        yield* input.fs.writeFileString(
          NodePath.join(input.directory, "t3-plugin.json"),
          JSON.stringify({
            ...manifest,
            capabilities: ["ui.native-trees", "ui.conversation-cards", "ui.wallpapers"],
            nativeTrees,
            views: [...views, ...wallpapers],
          }),
        );
        expect((yield* inspectPluginSource(input.directory)).manifest.nativeTrees).toEqual(
          nativeTrees,
        );
      }),
    ),
);

it.effect(
  "requires a declared create action and project-tree capability for project contributions",
  () =>
    provide(
      Effect.gen(function* () {
        const input = yield* fixture;
        const write = (capabilities: ReadonlyArray<string>, actionId: string) =>
          input.fs.writeFileString(
            NodePath.join(input.directory, "t3-plugin.json"),
            JSON.stringify({
              ...manifest,
              capabilities,
              actions: [{ id: "new", title: "New project", placements: [] }],
              nativeTrees: [
                {
                  id: "projects",
                  title: "Projects",
                  unplaced: "omit",
                  create: { actionId, title: "New project" },
                  emptyText: "Start a project.",
                },
              ],
            }),
          );
        yield* write(["ui.native-trees"], "new");
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        yield* write(["ui.native-trees", "ui.native-tree-projects"], "other-plugin-action");
        expect((yield* inspectPluginSource(input.directory).pipe(Effect.flip)).reason).toBe(
          "invalid_manifest",
        );
        yield* write(["ui.native-trees", "ui.native-tree-projects"], "new");
        expect(
          (yield* inspectPluginSource(input.directory)).manifest.nativeTrees?.[0]?.create?.actionId,
        ).toBe("new");
      }),
    ),
);
