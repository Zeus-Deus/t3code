// @effect-diagnostics nodeBuiltinImport:off -- exercise external packages in real Node children.
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Supervisor from "./PluginSupervisor.ts";

const examples = NodePath.resolve(import.meta.dirname, "fixtures/consumers");
const layer = Supervisor.layer.pipe(Layer.provide(NodeServices.layer));
const configuration = {
  selfInvocation: {
    command: process.execPath,
    entrypoint: NodePath.resolve(import.meta.dirname, "../bin.ts"),
  },
  startupTimeoutMs: 10_000,
  invocationTimeoutMs: 10_000,
  stopGraceMs: 500,
  restartBackoffMs: 0,
  maxFailures: 3,
};

it.live(
  "Quote Helper produces a composer request and a safely encoded ticket URL in a real worker",
  () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.PluginSupervisor;
      const base = {
        installationId: "example-quote",
        generation: "one",
        directory: NodePath.join(examples, "quote-helper"),
        entry: "plugin.mjs",
        dataDirectory: NodePath.join(examples, ".data"),
        caller: { kind: "client" as const },
        operationId: "quote-1",
      };
      const settings: Supervisor.PluginHostCall = () =>
        Effect.succeed("https://tracker.example/issues/{ticket}");
      const quote = yield* supervisor.invoke(
        {
          ...base,
          handler: "action:quote",
          context: { selection: "first line\nsecond line" },
        },
        settings,
      );
      expect(quote.intents).toEqual([
        {
          type: "composer.insert",
          text: "> first line\n> second line\n\nPlease review this and suggest improvements.\n",
        },
      ]);
      const ticket = yield* supervisor.invoke(
        {
          ...base,
          operationId: "ticket-1",
          handler: "action:ticket",
          input: { ticket: "PROJ-123" },
        },
        settings,
      );
      expect(ticket.intents).toEqual([
        { type: "preview.open", url: "https://tracker.example/issues/PROJ-123" },
      ]);
      const rejected = yield* supervisor.invoke(
        {
          ...base,
          operationId: "ticket-2",
          handler: "action:ticket",
          input: { ticket: "../../admin" },
        },
        settings,
      );
      expect(rejected.intents).toBeUndefined();
      const emptyNote = yield* supervisor.invoke(
        {
          ...base,
          operationId: "pad-empty",
          handler: "view:quote-pad:insert",
          input: { text: "  " },
        },
        settings,
      );
      expect(emptyNote.intents).toBeUndefined();
      expect(emptyNote.message).toBe("Enter text to insert into the composer.");
      const note = yield* supervisor.invoke(
        {
          ...base,
          operationId: "pad-note",
          handler: "view:quote-pad:insert",
          input: { text: `  ${"x".repeat(9000)}  ` },
        },
        settings,
      );
      expect(note.intents).toEqual([{ type: "composer.insert", text: "x".repeat(8000) }]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.provideService(Supervisor.PluginRuntimeConfig, configuration),
    ),
);

it.live(
  "Workflow Board retains its host-owned data after its worker is stopped and restarted",
  () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.PluginSupervisor;
      const storage = new Map<string, unknown>();
      const host: Supervisor.PluginHostCall = (method, input) =>
        Effect.sync(() => {
          const entry = input as { key: string; value?: unknown };
          if (method === "storage.get") return storage.get(entry.key) ?? null;
          if (method === "storage.set") {
            storage.set(entry.key, entry.value);
            return null;
          }
          if (method === "settings.get") return false;
          throw new Error(`Unexpected host operation ${method}`);
        });
      const base = {
        installationId: "example-board",
        generation: "one",
        directory: NodePath.join(examples, "workflow-board"),
        entry: "plugin.mjs",
        dataDirectory: NodePath.join(examples, ".data"),
        caller: { kind: "client" as const },
        operationId: "save-1",
      };
      yield* supervisor.invoke(
        {
          ...base,
          handler: "action:save-selection",
          context: { selection: "Check the error path" },
        },
        host,
      );
      yield* supervisor.stop(base.installationId);
      // Retrying a lost response uses the same operation identity after restarting.
      yield* supervisor.invoke(
        {
          ...base,
          handler: "action:save-selection",
          context: { selection: "Check the error path" },
        },
        host,
      );
      const board = yield* supervisor.invoke(
        { ...base, operationId: "list-1", handler: "view:board:list" },
        host,
      );
      expect(board.data).toMatchObject({ items: [{ id: "save-1", text: "Check the error path" }] });
      const finalized = {
        deliveryId: "delivery-1",
        threadId: "thread-1",
        projectId: "project-1",
        runId: "run-1",
        outcome: "completed",
      };
      yield* supervisor.invoke(
        { ...base, operationId: "event-1", handler: "event:run.finalized", input: finalized },
        host,
      );
      yield* supervisor.stop(base.installationId);
      yield* supervisor.invoke(
        { ...base, operationId: "event-1", handler: "event:run.finalized", input: finalized },
        host,
      );
      const after = yield* supervisor.invoke(
        { ...base, operationId: "list-2", handler: "view:board:list" },
        host,
      );
      expect(after.data).toMatchObject({
        items: [
          { id: "run-delivery-1", outcome: "completed" },
          { id: "save-1", text: "Check the error path" },
        ],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.provideService(Supervisor.PluginRuntimeConfig, configuration),
    ),
);
