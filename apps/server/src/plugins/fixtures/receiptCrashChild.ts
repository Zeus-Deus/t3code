// @effect-diagnostics nodeBuiltinImport:off -- this disposable process is killed at an IPC commit barrier.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as CoreReceipts from "../../persistence/OrchestrationCommandReceipts.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Receipts from "../PluginReceipts.ts";

const [filename, stage] = process.argv.slice(2);
if (!filename || !["reserved", "transaction", "committed"].includes(stage ?? ""))
  throw new Error("A receipt fixture database and stage are required.");

await Effect.gen(function* () {
  const receipts = yield* Receipts.PluginReceipts;
  const core = yield* CoreReceipts.OrchestrationCommandReceiptRepository;
  const sql = yield* SqlClient.SqlClient;
  const barrier = Effect.sync(() => process.send?.({ stage })).pipe(Effect.andThen(Effect.never));
  yield* receipts.reserve({
    installationId: "plugin",
    generation: "one",
    key: "crash-operation",
    requestDigest: "original",
    deliveryId: "run",
  });
  if (stage === "reserved") return yield* barrier;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const inserted = yield* core.insertIfAbsent({
        commandId: CommandId.make("crash-operation"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("retained-thread"),
        commandType: "thread.create",
        acceptedAt: "2026-10-23T12:00:00.000Z",
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      // This fixture models the core transaction, without starting a provider or real thread.
      if (inserted) yield* sql`INSERT INTO fixture_effects VALUES('retained-thread')`;
      if (stage === "transaction") return yield* barrier;
    }),
  );
  return yield* barrier;
}).pipe(
  Effect.provide(
    Layer.mergeAll(Receipts.layer, CoreReceipts.layer).pipe(
      Layer.provideMerge(Sqlite.layerFromPath(filename)),
      Layer.provide(NodeServices.layer),
    ),
  ),
  Effect.scoped,
  Effect.runPromise,
);
