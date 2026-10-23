import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { activate } from "./plugin.mjs";

const copy = (x) => structuredClone(x);
const source = {
  id: "source:/1",
  projectId: "project:/1",
  modelSelection: { instanceId: "codex", model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  archivedAt: null,
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(options = {}) {
  const handlers = new Map();
  const storage = options.storage ?? new Map();
  const calls = [];
  const effects = options.effects ?? new Map();
  let current;
  let revoked = false;
  let dispatch = options.dispatch;
  const metadata = new Map([
    [source.id, source],
    ["foreign", { ...source, id: "foreign" }],
  ]);
  const ctx = {
    capabilities: [
      "storage",
      "threads.read",
      "threads.create",
      "workflow.query",
      "ui",
      "ui.changes",
      ...(options.worktrees === false ? [] : ["worktrees.create"]),
    ],
    handle: (name, fn) => handlers.set(name, fn),
    storage: {
      get: async (key) => {
        calls.push(["storage.get", key]);
        NodeAssert.match(key, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
        return copy(storage.get(key) ?? null);
      },
      set: async (key, value) => {
        NodeAssert.match(key, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
        const next = Object.fromEntries(storage);
        next[key] = value;
        NodeAssert.ok(Buffer.byteLength(JSON.stringify(next)) <= 1000000);
        if (options.failWrite?.(value)) throw new Error("storage unavailable secret");
        storage.set(key, copy(value));
      },
    },
    threads: {
      metadata: async ({ threadId }) => {
        calls.push(["metadata", threadId]);
        if (revoked || !metadata.has(threadId)) throw new Error("permission_denied private");
        return copy(metadata.get(threadId));
      },
      create: async (request) => {
        calls.push(["create", copy(request), current.operationId]);
        NodeAssert.match(request.idempotencyKey, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
        NodeAssert.ok(
          [...storage.values()].some((state) => JSON.stringify(state).includes('"pending"')),
        );
        const key = `${options.principal ?? "client-session-a"}:${current.operationId}:${request.idempotencyKey}`;
        if (effects.has(key)) {
          NodeAssert.deepEqual(effects.get(key).request, request);
          return { threadId: effects.get(key).threadId };
        }
        if (dispatch) return dispatch(request, current, { effects, key, metadata });
        const threadId = `child-${effects.size + 1}`;
        effects.set(key, { request: copy(request), threadId });
        metadata.set(threadId, { ...source, id: threadId, launchedFrom: { threadId: source.id } });
        return { threadId };
      },
    },
    models: {
      list: async (input) => {
        calls.push(["models", input]);
        if (revoked) throw new Error("permission_denied");
        return {
          models: [
            {
              modelSelection: source.modelSelection,
              title: "Model",
              providerTitle: "Codex",
              options: [],
            },
          ],
          nextCursor: null,
        };
      },
    },
    ui: {
      invalidate: async (topics) => {
        calls.push(["invalidate", topics]);
      },
    },
    log: (_level, message) => {
      NodeAssert.ok(message.length < 300);
      NodeAssert.ok(!message.includes("secret"));
    },
  };
  await activate(ctx);
  const invocation = (extra = {}) => ({
    signal: new AbortController().signal,
    operationId: "click-1",
    caller: { kind: "client" },
    context: { threadId: source.id, projectId: source.projectId },
    ...extra,
  });
  const invoke = async (name, input, extra) => {
    current = invocation(extra);
    const result = await handlers.get(name)(input, current);
    return result;
  };
  const propose = async (tasks = [{ title: "Task", prompt: "Do one thing" }], extra = {}) =>
    invoke(
      "action:propose",
      { tasks },
      { caller: { kind: "agent", threadId: source.id }, ...extra },
    );
  const read = (planId, extra) => invoke("view:launcher:read", { planId }, extra);
  return {
    ctx,
    handlers,
    storage,
    effects,
    calls,
    invoke,
    propose,
    read,
    metadata,
    invocation,
    setDispatch: (fn) => {
      dispatch = fn;
    },
    revoke: () => {
      revoked = true;
    },
  };
}
const chosen = (proposal) => ({ planId: proposal.card.data.planId });
const firstTask = async (f, proposal) => ({
  ...chosen(proposal),
  taskId: (await f.read(chosen(proposal).planId)).data.plan.tasks[0].id,
});

NodeTest.test(
  "proposal uses verified caller metadata, immutable prompts, reference-only card, and bounded state",
  async () => {
    const f = await fixture();
    const p = await f.propose();
    NodeAssert.deepEqual(Object.keys(p.card.data), ["planId"]);
    NodeAssert.equal(p.message, p.card.summary);
    const { plan } = (await f.read(p.card.data.planId)).data;
    NodeAssert.equal(plan.sourceThreadId, source.id);
    NodeAssert.equal(plan.projectId, source.projectId);
    NodeAssert.deepEqual(plan.defaults.modelSelection, source.modelSelection);
    NodeAssert.equal(plan.tasks[0].prompt, "Do one thing");
    NodeAssert.equal(plan.tasks[0].launch.state, "proposed");
    NodeAssert.equal(f.calls.filter(([m]) => m === "create").length, 0);
    for (const state of f.storage.values()) NodeAssert.equal(state.version, 1);
    NodeAssert.ok(f.calls.some(([m]) => m === "invalidate"));
  },
);

NodeTest.test(
  "rejects outside-thread agents, context spoofing, malformed/oversized plans, and foreign plan reads",
  async () => {
    const f = await fixture();
    await NodeAssert.rejects(() => f.propose(undefined, { caller: { kind: "agent" } }), /verified/);
    await NodeAssert.rejects(
      () => f.propose(undefined, { context: { threadId: "foreign" } }),
      /context/,
    );
    await NodeAssert.rejects(
      () => f.propose(Array.from({ length: 7 }, () => ({ title: "T", prompt: "p" }))),
      /six|6/,
    );
    await NodeAssert.rejects(() => f.propose([{ title: "T", prompt: "p".repeat(2001) }]), /prompt/);
    await NodeAssert.rejects(
      () =>
        f.propose(
          Array.from({ length: 6 }, () => ({ title: "題".repeat(120), prompt: "長".repeat(2000) })),
        ),
      /24|large/,
    );
    const p = await f.propose();
    await NodeAssert.rejects(
      () => f.read(p.card.data.planId, { context: { threadId: "foreign" } }),
      /belong/,
    );
    await NodeAssert.rejects(
      () =>
        f.invoke(
          "action:propose",
          { tasks: [{ title: "T", prompt: "p" }], projectId: "foreign" },
          { caller: { kind: "agent", threadId: source.id } },
        ),
      /field/,
    );
  },
);

NodeTest.test(
  "only humans start; frozen model/mode/workspace request is persisted before dispatch and no parent spoof",
  async () => {
    const f = await fixture();
    const p = await f.propose();
    const input = await firstTask(f, p);
    await NodeAssert.rejects(
      () =>
        f.invoke("view:launcher:start", input, { caller: { kind: "agent", threadId: source.id } }),
      /person|human/,
    );
    await NodeAssert.rejects(
      () => f.invoke("view:launcher:start", { ...input, launchedFrom: { threadId: "foreign" } }),
      /field/,
    );
    const choices = {
      modelSelection: {
        instanceId: "codex",
        model: "other",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      runtimeMode: "auto",
      interactionMode: "plan",
      workspaceStrategy: {
        type: "worktree",
        baseRef: "main",
        branch: "task-one",
        startFromOrigin: false,
      },
    };
    const result = await f.invoke("view:launcher:start", { ...input, ...choices });
    NodeAssert.equal(result.data.results[0].state, "started");
    const request = f.calls.find(([m]) => m === "create")[1];
    NodeAssert.deepEqual(request, {
      projectId: source.projectId,
      title: "Task",
      text: "Do one thing",
      idempotencyKey: request.idempotencyKey,
      ...choices,
    });
    NodeAssert.equal(Object.hasOwn(request, "launchedFrom"), false);
    const replay = await f.invoke("view:launcher:start", input, { operationId: "new-click" });
    NodeAssert.equal(replay.data.results[0].threadId, result.data.results[0].threadId);
    NodeAssert.equal(f.calls.filter(([m]) => m === "create").length, 1);
  },
);

NodeTest.test("concurrent clicks serialize per plan and only one dispatch occurs", async () => {
  const f = await fixture();
  const input = await firstTask(f, await f.propose());
  const entered = deferred();
  const release = deferred();
  f.setDispatch(async (_request, _invocation, { metadata }) => {
    entered.resolve();
    await release.promise;
    metadata.set("child", { ...source, id: "child" });
    return { threadId: "child" };
  });
  const a = f.invoke("view:launcher:start", input);
  await entered.promise;
  const b = f.invoke("view:tasks:start", input, { operationId: "other-device" });
  release.resolve();
  const results = await Promise.all([a, b]);
  NodeAssert.equal(f.calls.filter(([m]) => m === "create").length, 1);
  NodeAssert.ok(results.every((r) => r.data.results[0].state === "started"));
});

NodeTest.test(
  "lost response and equal-operation different-client replay remain uncertain without reissue",
  async () => {
    const f = await fixture();
    const input = await firstTask(f, await f.propose());
    f.setDispatch(async (request, _invocation, { effects, key, metadata }) => {
      effects.set(key, { request: copy(request), threadId: "accepted" });
      metadata.set("accepted", { ...source, id: "accepted" });
      throw new Error("provider API secret: response lost");
    });
    const lost = await f.invoke("view:launcher:start", input, { operationId: "original" });
    NodeAssert.equal(lost.data.results[0].state, "uncertain");
    NodeAssert.ok(!JSON.stringify(lost).includes("secret"));
    const fresh = await f.invoke("view:launcher:start", input, { operationId: "fresh" });
    NodeAssert.equal(fresh.data.results[0].state, "uncertain");
    NodeAssert.match(fresh.data.results[0].diagnostic, /inspect/i);
    NodeAssert.equal(f.calls.filter(([m]) => m === "create").length, 1);
    const restored = await fixture({
      storage: f.storage,
      effects: f.effects,
      principal: "client-session-b",
    });
    restored.metadata.set("accepted", { ...source, id: "accepted" });
    const exact = await restored.invoke("view:launcher:start", input, { operationId: "original" });
    NodeAssert.equal(exact.data.results[0].state, "uncertain");
    NodeAssert.equal(exact.data.results[0].threadId, undefined);
    NodeAssert.equal(restored.calls.filter(([m]) => m === "create").length, 0);
    NodeAssert.equal(restored.effects.size, 1);
  },
);

NodeTest.test(
  "same operation with changed frozen choices is uncertain without another create",
  async () => {
    const f = await fixture({
      dispatch: async () => {
        throw new Error("lost");
      },
    });
    const input = await firstTask(f, await f.propose());
    await f.invoke("view:launcher:start", input);
    const changed = await f.invoke("view:launcher:start", { ...input, runtimeMode: "auto" });
    NodeAssert.equal(changed.data.results[0].state, "uncertain");
    NodeAssert.equal(f.calls.filter(([m]) => m === "create").length, 1);
  },
);

NodeTest.test(
  "pending survives success-journal storage failure and restart; fresh operation cannot dispatch",
  async () => {
    const f = await fixture({ failWrite: (value) => JSON.stringify(value).includes('"started"') });
    const input = await firstTask(f, await f.propose());
    NodeAssert.equal(
      (await f.invoke("view:launcher:start", input)).data.results[0].state,
      "uncertain",
    );
    const restarted = await fixture({ storage: f.storage, effects: f.effects });
    const result = await restarted.invoke("view:tasks:start", input, { operationId: "fresh" });
    NodeAssert.equal(result.data.results[0].state, "uncertain");
    NodeAssert.equal(restarted.calls.filter(([m]) => m === "create").length, 0);
  },
);

NodeTest.test(
  "failed pending write dispatches nothing and partial startAll keeps other task results",
  async () => {
    let failPending = true;
    const f = await fixture({
      failWrite: (state) => failPending && JSON.stringify(state).includes('"pending"'),
    });
    const p = await f.propose([
      { title: "A", prompt: "a" },
      { title: "B", prompt: "b" },
    ]);
    const plan = (await f.read(p.card.data.planId)).data.plan;
    const result = await f.invoke("view:tasks:startAll", {
      planId: plan.id,
      choices: plan.tasks.map((t) => ({ taskId: t.id })),
    });
    NodeAssert.equal(f.calls.filter(([m]) => m === "create").length, 0);
    NodeAssert.ok(result.data.results.every((r) => r.state === "proposed"));
    failPending = false;
    f.setDispatch(async (request, _invocation, { metadata }) => {
      if (request.title === "A") throw new Error("unknown");
      metadata.set("b", { ...source, id: "b" });
      return { threadId: "b" };
    });
    const partial = await f.invoke("view:tasks:startAll", {
      planId: plan.id,
      choices: plan.tasks.map((t) => ({ taskId: t.id })),
    });
    NodeAssert.deepEqual(
      partial.data.results.map((r) => r.state),
      ["uncertain", "started"],
    );
  },
);

NodeTest.test(
  "revocation on source or result disclosure never leaks stored state or target",
  async () => {
    const f = await fixture();
    const p = await f.propose();
    const input = await firstTask(f, p);
    const started = await f.invoke("view:launcher:start", input);
    f.metadata.delete(started.data.results[0].threadId);
    NodeAssert.equal(
      (await f.read(p.card.data.planId)).data.plan.tasks[0].launch.threadId,
      undefined,
    );
    f.revoke();
    await NodeAssert.rejects(() => f.read(p.card.data.planId), /permission_denied/);
    await NodeAssert.rejects(() => f.invoke("view:tasks:models", {}), /permission_denied/);
    await NodeAssert.rejects(() => f.invoke("status:tasks"), /permission_denied/);
  },
);

NodeTest.test(
  "cheap status, paged models, optional worktree gate, unknown stored version, bounded retention",
  async () => {
    const f = await fixture({ worktrees: false });
    const p = await f.propose();
    const input = await firstTask(f, p);
    NodeAssert.equal((await f.read(p.card.data.planId)).data.canWorktree, false);
    await NodeAssert.rejects(
      () =>
        f.invoke("view:tasks:start", {
          ...input,
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        }),
      /worktree/i,
    );
    NodeAssert.deepEqual(
      (await f.invoke("view:tasks:models", { cursor: 2 })).data.nextCursor,
      null,
    );
    const before = f.calls.length;
    NodeAssert.equal((await f.invoke("status:tasks")).data.label, "Tasks");
    NodeAssert.ok(
      !f.calls.slice(before).some(([m]) => ["models", "create", "storage.get"].includes(m)),
    );
    for (let i = 0; i < 30; i++) await f.propose();
    for (const state of f.storage.values()) NodeAssert.ok(state.plans.length <= 12);
    f.storage.set("plans.v1", { version: 2, plans: [] });
    await NodeAssert.rejects(() => f.read(), /version|format/);
  },
);

NodeTest.test(
  "a proposed state carrying an old dispatch journal is rejected instead of reset or redispatched",
  async () => {
    const f = await fixture({
      dispatch: async () => {
        throw new Error("lost");
      },
    });
    const input = await firstTask(f, await f.propose());
    await f.invoke("view:tasks:start", input);
    const stored = f.storage.get("plans.v1");
    stored.plans[0].tasks[0].launch.state = "proposed";
    f.storage.set("plans.v1", stored);
    const restarted = await fixture({ storage: f.storage });
    await NodeAssert.rejects(() => restarted.invoke("view:tasks:start", input), /journal|format/i);
    NodeAssert.equal(restarted.calls.filter(([m]) => m === "create").length, 0);
  },
);

NodeTest.test(
  "a thrown conflict never adopts a prior effect handle as this task's result",
  async () => {
    const f = await fixture({
      dispatch: async () => {
        const error = new Error("secret conflict detail");
        error.code = "idempotency_conflict";
        error.priorEffect = { threadId: "foreign" };
        throw error;
      },
    });
    const input = await firstTask(f, await f.propose());
    const result = await f.invoke("view:tasks:start", input);
    NodeAssert.equal(result.data.results[0].state, "uncertain");
    NodeAssert.equal(result.data.results[0].threadId, undefined);
    NodeAssert.ok(!JSON.stringify(result).includes("secret"));
  },
);

NodeTest.test(
  "model query rechecks source authorization after an in-flight public query",
  async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    f.ctx.models.list = async () => {
      entered.resolve();
      await release.promise;
      return { models: [{ title: "Private model" }], nextCursor: null };
    };
    const pending = f.invoke("view:tasks:models", {});
    await entered.promise;
    f.revoke();
    release.resolve();
    await NodeAssert.rejects(() => pending, /permission_denied/);
  },
);

NodeTest.test(
  "bounded retention never evicts unresolved journals to admit another proposal",
  async () => {
    const f = await fixture({
      dispatch: async () => {
        throw new Error("lost");
      },
    });
    for (let i = 0; i < 12; i++) {
      const input = await firstTask(f, await f.propose());
      await f.invoke("view:tasks:start", input, { operationId: `launch-${i}` });
    }
    const before = copy(f.storage.get("plans.v1"));
    await NodeAssert.rejects(() => f.propose(), /unresolved/);
    NodeAssert.deepEqual(f.storage.get("plans.v1"), before);
  },
);
