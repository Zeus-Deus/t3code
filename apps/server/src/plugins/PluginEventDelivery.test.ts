import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type PluginRunFinalizedEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as Database from "./PluginDatabase.ts";
import * as Store from "./PluginStore.ts";
import * as Service from "./PluginService.ts";
import * as Delivery from "./PluginEventDelivery.ts";
import { PluginExecutionPolicy } from "./PluginExecutionPolicy.ts";

const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const at = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
const record: Store.StoredInstallation = {
  directory: "/fixture",
  secrets: {},
  storage: {},
  eventCursor: 10,
  projectGrantStarts: { [projectId]: 10 },
  installation: {
    installationId: "plugin",
    generation: "one",
    manifest: {
      id: "test.observer",
      name: "Observer",
      version: "1.0.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["events.run-finalized"],
      actions: [],
      views: [],
      settings: [],
    },
    source: { kind: "local", directory: "/fixture" },
    digest: "0".repeat(64),
    enabled: true,
    consentedDigest: "0".repeat(64),
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["events.run-finalized"], projectIds: [projectId] },
    updatedAt: "2026-10-23T12:00:00.000Z",
  },
};
const event = (sequence: number): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event-${sequence}`),
    type: "run.updated",
    threadId,
    runId: RunId.make(`run-${sequence}`),
    occurredAt: at,
    payload: {
      id: RunId.make(`run-${sequence}`),
      threadId,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make(`user-${sequence}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  },
});
const base = () =>
  Database.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Sqlite.layerMemory,
        Config.layerTest(process.cwd(), { prefix: "plugin-delivery-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
const fixture = Effect.fn("test.deliveryFixture")(function* (initial: Store.StoredInstallation) {
  const store = Context.get(yield* Layer.build(Store.layer), Store.PluginStore);
  yield* store.update((state) =>
    Effect.succeed([undefined, { ...state, installations: [initial] }] as const),
  );
  const delivered: Array<PluginRunFinalizedEvent> = [];
  let backlogChecks = 0;
  const shell = v2PullRequestThread({
    id: threadId,
    projectId,
    title: "Test",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  });
  const layer = Delivery.layer.pipe(
    Layer.provide(Layer.succeed(Store.PluginStore, store)),
    Layer.provide(
      Layer.mock(Service.PluginService)({
        backlog: () =>
          Effect.gen(function* () {
            backlogChecks++;
            const current = (yield* store.read.pipe(Effect.orDie)).installations[0]!;
            return {
              count: [20, 50, 51].filter(
                (sequence) =>
                  sequence > current.eventCursor &&
                  sequence > (current.projectGrantStarts?.[projectId] ?? current.eventCursor) &&
                  current.installation.grants.projectIds.includes(projectId),
              ).length,
              afterSequence: current.eventCursor,
              throughSequence: 80,
              requiresChoice: true,
            };
          }),
        deliver: (input) =>
          Effect.sync(() => {
            delivered.push(input.event);
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(shell) }),
    ),
    Layer.provide(
      Layer.mock(Events.OrchestrationEventStore)({
        latestApplicationSequence: Effect.succeed(80),
        readAgentEvents: (input) =>
          Stream.fromArray(
            [event(20), event(50), event(51)].filter(
              (item) =>
                item.sequence > (input?.afterSequence ?? 0) &&
                item.sequence <= (input?.throughSequence ?? 80),
            ),
          ),
        streamApplicationEvents: () => Stream.never,
      }),
    ),
  );
  const delivery = Context.get(yield* Layer.build(layer), Delivery.PluginEventDelivery);
  yield* delivery.drain;
  return { store, delivered, delivery, backlogChecks: () => backlogChecks };
});
it.effect("never delivers project history from before its grant start", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ ...record, projectGrantStarts: { [projectId]: 50 } });
    expect(f.delivered.map((item) => item.runId)).toEqual([RunId.make("run-51")]);
    expect((yield* f.store.read).installations[0]?.eventCursor).toBe(80);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect(
  "freezes unavailable observers and retains explicit recovery choice when support returns",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        ...record,
        installation: {
          ...record.installation,
          manifest: {
            ...record.installation.manifest,
            capabilities: ["events.run-finalized", "future.required"],
          },
        },
      });
      expect(f.delivered).toEqual([]);
      expect((yield* f.store.read).installations[0]).toMatchObject({
        eventCursor: 10,
        eventBacklogChoiceRequired: true,
      });
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((current) => ({
              ...current,
              installation: record.installation,
            })),
          },
        ] as const),
      );
      yield* f.delivery.catchUp();
      yield* f.delivery.drain;
      expect(f.delivered).toEqual([]);
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((current) => ({
              ...current,
              eventBacklogChoiceRequired: false,
            })),
          },
        ] as const),
      );
      yield* f.delivery.catchUp();
      yield* f.delivery.drain;
      expect(f.delivered).toHaveLength(3);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("safe mode prevents delivery despite stale enabled catalogue status", () =>
  Effect.gen(function* () {
    const f = yield* fixture(record);
    expect(f.delivered).toEqual([]);
    expect((yield* f.store.read).installations[0]).toMatchObject({
      eventCursor: 10,
      eventBacklogChoiceRequired: true,
    });
  }).pipe(
    Effect.provideService(PluginExecutionPolicy, {
      safeMode: true,
      hostVersion: "test",
      nodeVersion: process.versions.node,
    }),
    Effect.provide(base()),
    Effect.scoped,
  ),
);

it.effect(
  "clears a recovered gap with zero relevant missed runs without pausing future delivery",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        ...record,
        eventBacklogChoiceRequired: true,
        projectGrantStarts: { [projectId]: 80 },
      });
      expect(f.delivered).toEqual([]);
      expect((yield* f.store.read).installations[0]).toMatchObject({
        eventBacklogChoiceRequired: false,
        eventCursor: 80,
      });
      expect(f.backlogChecks()).toBe(1);
      yield* f.delivery.catchUp();
      yield* f.delivery.drain;
      expect(f.backlogChecks()).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect(
  "counts a recovered nonempty gap once rather than rescanning on every live notification",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ ...record, eventBacklogChoiceRequired: true });
      expect(f.delivered).toEqual([]);
      expect(f.backlogChecks()).toBe(1);
      yield* f.delivery.catchUp();
      yield* f.delivery.drain;
      yield* f.delivery.catchUp();
      yield* f.delivery.drain;
      expect(f.backlogChecks()).toBe(1);
      expect((yield* f.store.read).installations[0]?.eventBacklogChoiceRequired).toBe(true);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
