import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpProviderSessions from "./McpProviderSessions.ts";

const session = {
  environmentId: EnvironmentId.make("cards-test"),
  threadId: ThreadId.make("card-thread"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("provider"),
  endpoint: "http://localhost/mcp",
  authorizationHeader: "fixture-only",
  browserToolsAvailable: false,
};
const request = {
  installationId: "tasks",
  generation: "generation-1",
  actionId: "propose",
  operationId: "proposal-1",
};
const card = {
  installationId: "tasks",
  generation: "generation-1",
  dataOwner: "retained-tasks",
  viewId: "launch",
  summary: "Proposed two tasks.",
  data: { planId: "plan-1" },
};

it.effect("recovers a plugin card only for its exact completed invocation", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set(session);
    yield* sessions.recordPluginCard(session, request, card);
    for (const changed of [
      { installationId: "other" },
      { generation: "generation-2" },
      { actionId: "other" },
      { operationId: "proposal-2" },
    ]) {
      expect(
        yield* sessions.takePluginCard(session.threadId, { ...request, ...changed }),
      ).toBeUndefined();
    }
    expect(yield* sessions.takePluginCard(ThreadId.make("other-thread"), request)).toBeUndefined();
    expect(yield* sessions.takePluginCard(session.threadId, request)).toEqual(card);
    expect(yield* sessions.takePluginCard(session.threadId, request)).toBeUndefined();
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("does not recover cards from a stale or missing provider session", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.recordPluginCard(session, request, card);
    expect(yield* sessions.takePluginCard(session.threadId, request)).toBeUndefined();
    yield* sessions.set(session);
    yield* sessions.recordPluginCard(session, request, card);
    yield* sessions.set({ ...session, providerSessionId: "provider-session-2" });
    yield* sessions.recordPluginCard(session, request, card);
    expect(yield* sessions.takePluginCard(session.threadId, request)).toBeUndefined();
    const replacement = {
      ...session,
      providerSessionId: "provider-session-2",
      providerInstanceId: ProviderInstanceId.make("replacement"),
    };
    yield* sessions.set(replacement);
    yield* sessions.recordPluginCard(
      { ...session, providerSessionId: "provider-session-2" },
      request,
      card,
    );
    expect(yield* sessions.takePluginCard(session.threadId, request)).toBeUndefined();
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);

it.effect("keeps plugin card recovery bounded and clears it with the provider session", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    yield* sessions.set(session);
    for (let index = 0; index < 65; index++) {
      yield* sessions.recordPluginCard(
        session,
        { ...request, operationId: `proposal-${index}` },
        { ...card, data: { planId: `plan-${index}` } },
      );
    }
    expect(
      yield* sessions.takePluginCard(session.threadId, { ...request, operationId: "proposal-0" }),
    ).toBeUndefined();
    expect(
      yield* sessions.takePluginCard(session.threadId, { ...request, operationId: "proposal-64" }),
    ).toMatchObject({ data: { planId: "plan-64" } });
    yield* sessions.clear(session.threadId);
    expect(
      yield* sessions.takePluginCard(session.threadId, { ...request, operationId: "proposal-63" }),
    ).toBeUndefined();
  }).pipe(Effect.provide(McpProviderSessions.layer)),
);
