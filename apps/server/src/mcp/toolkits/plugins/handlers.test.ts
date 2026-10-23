import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  PluginError,
  ThreadId,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { McpSchema, McpServer } from "effect/ai";

import * as PluginService from "../../../plugins/PluginService.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { layerPluginToolkit } from "../../McpHttpServer.ts";
import * as Handlers from "./handlers.ts";
import { PluginToolkit } from "./tools.ts";

const installation: PluginInstallation = {
  installationId: "example-plugin",
  generation: "generation-1",
  manifest: {
    id: "examples.test",
    name: "Test plugin",
    version: "1.0.0",
    apiVersion: 1,
    entry: "plugin.mjs",
    capabilities: ["ui"],
    settings: [],
    views: [],
    actions: [
      { id: "agent-action", title: "Agent action", placements: [], agentCallable: true },
      { id: "private-action", title: "Private action", placements: ["palette"] },
    ],
  },
  source: { kind: "local", directory: "/private/plugin/source" },
  digest: "a".repeat(64),
  consentedDigest: "a".repeat(64),
  enabled: true,
  status: "idle",
  error: null,
  settings: {},
  grants: { capabilities: ["ui"], projectIds: [] },
  updatedAt: "2026-10-22T00:00:00.000Z",
};

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("plugin-test"),
  requestNamespace: "plugin-test",
  thread: {
    threadId: ThreadId.make("plugin-test-thread"),
    providerSessionId: "plugin-test-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const activeSessions = Layer.mock(SessionStore.SessionStore)({
  cookieName: "plugin-test",
  legacyCookieName: undefined,
  assertActive: () => Effect.void,
});

const handlersWith = (
  plugins: Layer.Layer<PluginService.PluginService>,
  sessions: Layer.Layer<SessionStore.SessionStore> = activeSessions,
) =>
  McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(plugins, liveThreadsLayer, sessions)),
  );

it.effect("keeps a card result recoverable only for the verified agent invocation", () =>
  Effect.gen(function* () {
    const sessions = yield* McpProviderSessions.McpProviderSessions;
    const server = yield* McpServer.McpServer;
    const thread = scope.thread!;
    yield* sessions.set({
      ...thread,
      environmentId: scope.environmentId,
      endpoint: "http://localhost/mcp",
      authorizationHeader: "fixture-only",
      browserToolsAvailable: false,
    });
    const input = {
      installationId: installation.installationId,
      generation: installation.generation,
      actionId: "agent-action",
      operationId: "proposal-1",
      context: { threadId: "different-target" },
    };
    const result = yield* server
      .callTool({ name: "t3_plugin_invoke", arguments: input })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ card: { dataOwner: "retained-tasks" } });
    expect(
      yield* sessions.takePluginCard(ThreadId.make("different-target"), input),
    ).toBeUndefined();
    expect(
      yield* sessions.takePluginCard(thread.threadId, { ...input, operationId: "other" }),
    ).toBeUndefined();
    expect(yield* sessions.takePluginCard(thread.threadId, input)).toMatchObject({
      viewId: "launch",
      data: { planId: "plan-1" },
    });
  }).pipe(
    Effect.provide(
      layerPluginToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(McpProviderSessions.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PluginService.PluginService)({
              invoke: () =>
                Effect.succeed({
                  message: "Proposed two tasks.",
                  card: {
                    installationId: installation.installationId,
                    generation: installation.generation,
                    dataOwner: "retained-tasks",
                    viewId: "launch",
                    summary: "Proposed two tasks.",
                    data: { planId: "plan-1" },
                  },
                }),
            }),
            liveThreadsLayer,
            activeSessions,
          ),
        ),
      ),
    ),
  ),
);

it.effect("registers both plugin tools through the production MCP adapter", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name)).toContain("t3_plugin_list");
    expect(server.tools.map(({ tool }) => tool.name)).toContain("t3_plugin_invoke");
  }).pipe(
    Effect.provide(
      layerPluginToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PluginService.PluginService)({}),
            liveThreadsLayer,
            activeSessions,
          ),
        ),
      ),
    ),
  ),
);

it.effect("returns verified plugin images as image content unless the agent opts out", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const call = (includeImages?: boolean) =>
      server
        .callTool({
          name: "t3_plugin_invoke",
          arguments: {
            installationId: installation.installationId,
            generation: installation.generation,
            actionId: "agent-action",
            operationId: "shot",
            ...(includeImages === undefined ? {} : { includeImages }),
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
        );
    const shown = yield* call();
    expect(shown.isError).toBe(false);
    expect(shown.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(shown.content[1]).toMatchObject({ mimeType: "image/png", data: new Uint8Array(png) });
    expect(JSON.stringify(shown.structuredContent)).not.toContain(png.toString("base64"));
    expect(shown.structuredContent).toEqual({
      message: "Captured",
      images: [{ mimeType: "image/png" }],
    });
    const omitted = yield* call(false);
    expect(omitted.content.map((entry) => entry.type)).toEqual(["text"]);
    expect(omitted.structuredContent).toMatchObject({ imagesOmitted: true });
  }).pipe(
    Effect.provide(
      layerPluginToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(PluginService.PluginService)({
              invoke: () =>
                Effect.succeed({
                  message: "Captured",
                  images: [
                    {
                      mimeType: "image/png" as const,
                      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
                        "base64",
                      ),
                    },
                  ],
                }),
            }),
            liveThreadsLayer,
            activeSessions,
          ),
        ),
      ),
    ),
  ),
);

it.effect("only lists available agent actions without exposing installation paths", () =>
  Effect.gen(function* () {
    const toolkit = yield* PluginToolkit;
    const result = yield* toolkit
      .handle("t3_plugin_list", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toEqual({
      plugins: [
        {
          installationId: installation.installationId,
          generation: installation.generation,
          id: installation.manifest.id,
          name: installation.manifest.name,
          observerError: "The background observer is paused.",
          actions: [{ id: "agent-action", title: "Agent action" }],
        },
      ],
    });
  }).pipe(
    Effect.provide(
      handlersWith(
        Layer.mock(PluginService.PluginService)({
          list: () =>
            Effect.succeed({
              installations: [
                { ...installation, observerError: "The background observer is paused." },
                { ...installation, installationId: "disabled", enabled: false },
                { ...installation, installationId: "unreviewed", consentedDigest: null },
              ],
            }),
        }),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  ),
);

it.effect("read-only outside agents cannot run a plugin action", () =>
  Effect.gen(function* () {
    const toolkit = yield* PluginToolkit;
    const result = yield* toolkit
      .handle("t3_plugin_invoke", {
        installationId: installation.installationId,
        generation: installation.generation,
        actionId: "agent-action",
        operationId: "operation-1",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      handlersWith(
        Layer.mock(PluginService.PluginService)({
          invoke: () => Effect.die("Read-only action reached plugin code"),
        }),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      ...scope,
      thread: undefined,
      client: { sessionId: "read-only", label: "Outside agent", access: "read-only" },
    }),
  ),
);

it.effect(
  "reports worker timeouts as execution failures rather than malformed agent requests",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      const result = yield* toolkit
        .handle("t3_plugin_invoke", {
          installationId: installation.installationId,
          generation: installation.generation,
          actionId: "agent-action",
          operationId: "timeout-test",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(result.at(-1)?.result).toMatchObject({
        code: "orchestration_error",
        message: "Plugin timed out.",
      });
    }).pipe(
      Effect.provide(
        handlersWith(
          Layer.mock(PluginService.PluginService)({
            invoke: () =>
              Effect.fail(new PluginError({ reason: "timeout", message: "Plugin timed out." })),
          }),
        ),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    ),
);

it.effect(
  "namespaces the same semantic operation ID separately for different agent threads",
  () => {
    const principals: string[] = [];
    const threadIds: Array<ThreadId | undefined> = [];
    return Effect.gen(function* () {
      const toolkit = yield* PluginToolkit;
      for (const id of ["agent-one", "agent-two"]) {
        yield* toolkit
          .handle("t3_plugin_invoke", {
            installationId: installation.installationId,
            generation: installation.generation,
            actionId: "agent-action",
            operationId: "new-review",
            context: { threadId: ThreadId.make("thread:requested-target") },
            input: { threadId: "thread:forged", subagentOf: "thread:forged-parent" },
          })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, {
              ...scope,
              thread: {
                threadId: ThreadId.make(id),
                providerSessionId: `session-${id}`,
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
            }),
          );
      }
      expect(principals).toHaveLength(2);
      expect(new Set(principals).size).toBe(2);
      expect(threadIds).toEqual(["agent-one", "agent-two"]);
    }).pipe(
      Effect.provide(
        handlersWith(
          Layer.mock(PluginService.PluginService)({
            invoke: (_input, actor) =>
              Effect.sync(() => {
                principals.push(actor.principalId);
                threadIds.push(actor.threadId);
                return { message: "Invoked" };
              }),
          }),
        ),
      ),
    );
  },
);

it.effect("rechecks an outside agent session before every plugin host effect", () => {
  let revoked = false;
  let authorizedEffects = 0;
  const sessionId = AuthSessionId.make("outside-agent-session");
  return Effect.gen(function* () {
    const toolkit = yield* PluginToolkit;
    const result = yield* toolkit
      .handle("t3_plugin_invoke", {
        installationId: installation.installationId,
        generation: installation.generation,
        actionId: "agent-action",
        operationId: "revoke-during-action",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(authorizedEffects).toBe(1);
  }).pipe(
    Effect.provide(
      handlersWith(
        Layer.mock(PluginService.PluginService)({
          invoke: (_input, actor) =>
            Effect.gen(function* () {
              if (actor.authorize === undefined)
                return yield* Effect.die("Missing live authorization");
              yield* actor.authorize();
              authorizedEffects++;
              revoked = true;
              yield* actor.authorize();
              authorizedEffects++;
              return {};
            }),
        }),
        Layer.mock(SessionStore.SessionStore)({
          cookieName: "plugin-test",
          legacyCookieName: undefined,
          assertActive: (id) => {
            expect(id).toBe(sessionId);
            return revoked
              ? Effect.fail(
                  new SessionStore.SessionCredentialVerificationError({
                    sessionId,
                    cause: new Error("Session revoked"),
                  }),
                )
              : Effect.void;
          },
        }),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      ...scope,
      thread: undefined,
      client: { sessionId, label: "Outside agent", access: "full-access" },
    }),
  );
});
