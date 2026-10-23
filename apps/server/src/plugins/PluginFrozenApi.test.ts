// @effect-diagnostics nodeBuiltinImport:off -- exercise an unchanged external artifact in a real child.
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginManifest, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Supervisor from "./PluginSupervisor.ts";

const directory = NodePath.join(import.meta.dirname, "fixtures/frozen-v1");
// This pre-release artifact must remain unchanged as the host evolves. Add a fixture for a new ABI.
const artifacts = {
  "t3-plugin.json": "54b04fbfc6424f1c7f378f2055c761172ee60dee5c2632a5570a53e0bd74c766",
  "plugin.mjs": "7054ff6c2aa83e9beff10d3f3dc887607e875de254e48d936c8e2269f89e7501",
  "view.html": "cd0d4be64a5def1d5ee192e699cf6c1205d9af6c2800f52cb37caa4a27c15b34",
};
const readStorage = Schema.decodeUnknownEffect(Schema.Struct({ key: Schema.String }));
const writeStorage = Schema.decodeUnknownEffect(
  Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
);
const readThread = Schema.decodeUnknownEffect(Schema.Struct({ threadId: Schema.String }));
const createThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    projectId: Schema.String,
    title: Schema.String,
    text: Schema.String,
    idempotencyKey: Schema.String,
  }),
);
const sendThread = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: Schema.String, text: Schema.String, idempotencyKey: Schema.String }),
);
const layer = Supervisor.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live("runs the frozen v1 author artifact without rebuilding it against the current SDK", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    for (const [file, expected] of Object.entries(artifacts)) {
      const bytes = yield* fs.readFile(NodePath.join(directory, file));
      expect(yield* crypto.digest("SHA-256", bytes).pipe(Effect.map(Hex.encode))).toBe(expected);
    }
    const manifest = yield* fs
      .readFileString(NodePath.join(directory, "t3-plugin.json"))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest))));
    const supervisor = yield* Supervisor.PluginSupervisor;
    const storage = new Map<string, unknown>();
    const created: unknown[] = [];
    const sent: unknown[] = [];
    const host: Supervisor.PluginHostCall = (method, input) =>
      Effect.gen(function* () {
        switch (method) {
          case "settings.get": {
            const setting = yield* readStorage(input).pipe(Effect.orDie);
            expect(setting.key).toBe("autoSend");
            return true;
          }
          case "storage.get": {
            const { key } = yield* readStorage(input).pipe(Effect.orDie);
            return storage.get(key) ?? null;
          }
          case "storage.set": {
            const { key, value } = yield* writeStorage(input).pipe(Effect.orDie);
            storage.set(key, value);
            return null;
          }
          case "storage.delete": {
            const { key } = yield* readStorage(input).pipe(Effect.orDie);
            storage.delete(key);
            return null;
          }
          case "threads.read": {
            const { threadId } = yield* readThread(input).pipe(Effect.orDie);
            return {
              id: threadId,
              projectId: "project:v1",
              title: "Existing thread",
              messages: [],
            };
          }
          case "threads.create": {
            created.push(yield* createThread(input).pipe(Effect.orDie));
            return { threadId: "thread:created" };
          }
          case "threads.send": {
            const request = yield* sendThread(input).pipe(Effect.orDie);
            sent.push(request);
            return { threadId: request.threadId };
          }
        }
      });
    const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "frozen-plugin-data-" });
    const base = {
      installationId: "frozen-v1",
      generation: "before-upgrade",
      directory,
      entry: manifest.entry,
      dataDirectory,
      caller: { kind: "client" as const },
      capabilities: manifest.capabilities,
      context: { threadId: ThreadId.make("thread:v1"), projectId: ProjectId.make("project:v1") },
    };
    const result = yield* supervisor.invoke(
      { ...base, handler: "action:exercise", operationId: "exercise" },
      host,
    );
    expect(result.data).toEqual({
      apiVersion: 1,
      title: "Existing thread",
      threadId: "thread:created",
    });
    expect(result.intents).toEqual([
      { type: "composer.insert", text: "Review request prepared." },
      { type: "preview.open", url: "https://example.com/review" },
      { type: "thread.reveal", threadId: "thread:created" },
      { type: "view.open", viewId: "summary" },
    ]);
    expect(created).toEqual([
      {
        projectId: "project:v1",
        title: "Frozen v1 review",
        text: "Review the public API.",
        idempotencyKey: "review",
      },
    ]);
    yield* supervisor.stop(base.installationId);
    const resumed = { ...base, generation: "after-upgrade" };
    expect(
      (yield* supervisor.invoke(
        { ...resumed, handler: "view:summary:read", operationId: "view" },
        host,
      )).data,
    ).toEqual({ title: "Existing thread" });
    yield* supervisor.invoke(
      {
        ...resumed,
        handler: "event:run.finalized",
        operationId: "run:v1",
        input: {
          deliveryId: "run:v1",
          threadId: "thread:v1",
          projectId: "project:v1",
          runId: "run:v1",
          outcome: "completed",
        },
      },
      host,
    );
    expect(sent).toEqual([
      {
        threadId: "thread:v1",
        text: "Review this completed run.",
        idempotencyKey: "review-run:v1",
      },
    ]);
    expect(storage.get("lastDelivery")).toBe("run:v1");
  }).pipe(
    Effect.scoped,
    Effect.provide(layer),
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
  ),
);
