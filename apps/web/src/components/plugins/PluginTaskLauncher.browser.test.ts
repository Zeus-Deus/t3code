import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  makePluginViewHost,
  type PluginViewBridgeFeature,
  type PluginViewContext,
} from "@t3tools/client-runtime/plugins";
import type { PluginClientIntent, PluginInvokeResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import viewHtml from "../../../../../examples/plugins/task-launcher/view.html?raw";

const TOKEN = "task-launcher-token";
const CARD_FEATURES: ReadonlyArray<PluginViewBridgeFeature> = [
  "changes",
  "local-intents",
  "resize",
  "card-context",
];

interface Call {
  readonly name: string;
  readonly input: unknown;
  readonly resolve: (result: PluginInvokeResult) => void;
  readonly reject: (error: Error) => void;
}

type Launch =
  | { state: "proposed" }
  | { state: "started"; threadId?: string; diagnostic?: string; choices?: unknown }
  | { state: "uncertain" | "pending"; diagnostic?: string; choices?: unknown };

const DEFAULTS = {
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
const UNCERTAIN =
  "Launch outcome is uncertain. Inspect threads before starting this work elsewhere.";

const task = (id: string, title: string, launch: Launch = { state: "proposed" }) => ({
  id,
  title,
  prompt: `Prompt for ${title}.`,
  launch,
});

const planData = (
  tasks: ReadonlyArray<ReturnType<typeof task>>,
  extra: Record<string, unknown> = {},
) => ({
  plan: {
    version: 1,
    id: "plan-1",
    title: "Review follow-ups",
    sourceThreadId: "thread-1",
    projectId: "project-1",
    createdAt: "2026-10-23T12:00:00.000Z",
    defaults: DEFAULTS,
    tasks,
  },
  canStart: true,
  canWorktree: true,
  ...extra,
});

const card = (features: ReadonlyArray<PluginViewBridgeFeature>): PluginViewContext => ({
  theme: "light",
  styles: {},
  platform: "web",
  placement: "conversation",
  view: { installationId: "inst-1", viewId: "launcher" },
  thread: { threadId: "thread-1", projectId: "project-1" },
  features,
  card: {
    viewId: "launcher",
    summary: "Proposed 3 tasks. Review before starting.",
    data: { planId: "plan-1" },
  },
});

const sidePanel: PluginViewContext = {
  theme: "light",
  styles: {},
  platform: "web",
  placement: "side-panel",
  view: { installationId: "inst-1", viewId: "tasks" },
  thread: { threadId: "thread-1", projectId: "project-1" },
  features: ["changes", "local-intents"],
};

/**
 * Mounts the shipped view behind the real bridge with the features the context lists. The frame
 * is left same-origin (production adds `sandbox="allow-scripts"`) only so the test can read and
 * drive its DOM.
 */
function mountView(initial: PluginViewContext) {
  let context = initial;
  const features = initial.features ?? [];
  const calls: Call[] = [];
  const intents: PluginClientIntent[] = [];
  const frame = document.createElement("iframe");
  const channel = bindPluginViewChannel({
    token: TOKEN,
    source: () => frame.contentWindow,
    receive: (data) => host.receive(data),
  });
  const host = makePluginViewHost({
    token: TOKEN,
    post: channel.post,
    context: () => context,
    captureOrigin: () => null,
    invoke: (name, input) =>
      new Promise<PluginInvokeResult>((resolve, reject) => {
        calls.push({ name, input, resolve, reject });
      }),
    onIntents: (next) => intents.push(...next),
    features,
  });
  frame.srcdoc = buildPluginViewDocument(viewHtml, TOKEN, features);
  document.body.append(frame);
  const doc = () => frame.contentDocument!;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => {
    const found = doc().querySelector<T>(selector);
    if (!found) throw new Error(`No ${selector}`);
    return found;
  };
  const nextCall = (name: string) =>
    vi.waitFor(() => {
      const call = calls.find((entry) => entry.name === name);
      if (!call) throw new Error(`No ${name} call yet.`);
      calls.splice(calls.indexOf(call), 1);
      return call;
    });
  const row = (taskId: string) => $(`#tasks li[data-task-id="${taskId}"]`);
  return {
    calls,
    intents,
    host,
    doc,
    $,
    nextCall,
    row,
    /** Waits until the row shows the given state. */
    rowState: (taskId: string, state: string) =>
      vi.waitFor(() => expect(row(taskId).dataset.state).toBe(state)),
    setContext: (next: PluginViewContext) => {
      context = next;
      host.sendContext();
    },
    choose: (selector: string, value: string) => {
      const select = $<HTMLSelectElement>(selector);
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    type: (selector: string, value: string) => {
      const input = $<HTMLInputElement>(selector);
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [Symbol.dispose]: () => {
      host.dispose();
      channel.dispose();
      frame.remove();
    },
  };
}

const startButton = (view: ReturnType<typeof mountView>, taskId: string) =>
  view.row(taskId).querySelector<HTMLButtonElement>('button[data-action="start"]');

it("shows each task's recorded launch state and never offers to restart an uncertain one", async () => {
  using view = mountView(card(CARD_FEATURES));
  const read = await view.nextCall("read");
  expect(read.input).toEqual({ planId: "plan-1" });
  read.resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test", { state: "started", threadId: "thread-child" }),
      task("t3", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN }),
      // An older backend may still say pending; it is as uncertain as a thrown create.
      task("t4", "Bump deps", { state: "pending" }),
    ]),
  });

  await view.rowState("t1", "proposed");
  expect(view.$("#title").textContent).toBe("Review follow-ups");
  expect(view.$("#tally").textContent).toBe("1 not started · 1 started · 2 uncertain");
  expect(startButton(view, "t1")!.getAttribute("aria-label")).toBe("Start Review tests");

  for (const id of ["t3", "t4"]) {
    expect(view.row(id).dataset.state).toBe("uncertain");
    expect(startButton(view, id)).toBeNull();
  }
  expect(view.row("t3").querySelector(".diagnostic")!.textContent).toBe(UNCERTAIN);
  expect(view.row("t4").querySelector(".diagnostic")!.textContent).toContain("Inspect threads");
  // One task left to start, so there is no Start all.
  expect(view.$("#start-all").hidden).toBe(true);

  view.row("t2").querySelector<HTMLButtonElement>('button[data-action="open"]')!.click();
  await vi.waitFor(() =>
    expect(view.intents).toEqual([{ type: "thread.reveal", threadId: "thread-child" }]),
  );
  // Nothing asked for the model catalog, and nothing started on its own.
  expect(view.calls.map((call) => call.name)).toEqual([]);
});

it("starts one task with the settings shown, and a refused start rereads instead of retrying", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")]),
  });
  await view.rowState("t1", "proposed");

  view.choose("#runtime", "full-access");
  view.choose("#interaction", "plan");
  startButton(view, "t1")!.click();
  const start = await view.nextCall("start");
  expect(start.input).toEqual({
    planId: "plan-1",
    taskId: "t1",
    modelSelection: DEFAULTS.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    workspaceStrategy: { type: "root" },
  });
  await view.rowState("t1", "starting");
  expect(startButton(view, "t2")!.disabled).toBe(true);
  expect(view.$<HTMLButtonElement>("#start-all").disabled).toBe(true);

  start.reject(new Error("Session cannot operate threads in this project."));
  const reread = await view.nextCall("read");
  expect(reread.input).toEqual({ planId: "plan-1" });
  await vi.waitFor(() =>
    expect(view.$("#failure-text").textContent).toBe(
      "Session cannot operate threads in this project.",
    ),
  );
  reread.resolve({
    data: planData([
      task("t1", "Review tests", { state: "uncertain", diagnostic: UNCERTAIN }),
      task("t2", "Fix flaky test"),
    ]),
  });
  await view.rowState("t1", "uncertain");
  expect(startButton(view, "t1")).toBeNull();
  expect(startButton(view, "t2")!.disabled).toBe(false);
  expect(view.calls.filter((call) => call.name === "start")).toEqual([]);
});

it("starts every task not yet started and keeps each outcome of a partial run", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test", { state: "uncertain", diagnostic: UNCERTAIN }),
      task("t3", "Update docs"),
    ]),
  });
  await view.rowState("t1", "proposed");
  expect(view.$("#start-all").textContent).toBe("Start 2 tasks");

  view.$("#start-all").click();
  const startAll = await view.nextCall("startAll");
  const choices = {
    modelSelection: DEFAULTS.modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  };
  expect(startAll.input).toEqual({
    planId: "plan-1",
    choices: [
      { taskId: "t1", ...choices },
      { taskId: "t3", ...choices },
    ],
  });
  await view.rowState("t3", "starting");
  expect(view.row("t2").dataset.state).toBe("uncertain");

  startAll.resolve({
    data: {
      ...planData([
        task("t1", "Review tests", { state: "started", threadId: "thread-a" }),
        task("t2", "Fix flaky test", { state: "uncertain", diagnostic: UNCERTAIN }),
        task("t3", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN }),
      ]),
      results: [
        { taskId: "t1", state: "started", threadId: "thread-a" },
        { taskId: "t3", state: "uncertain", diagnostic: UNCERTAIN },
      ],
    },
  });
  await view.rowState("t1", "started");
  expect(view.row("t3").dataset.state).toBe("uncertain");
  expect(view.$("#tally").textContent).toBe("1 started · 2 uncertain");
  expect(view.$("#start-all").hidden).toBe(true);
});

it("needs an explicit base ref for a worktree and offers worktrees only when granted", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests")], { canWorktree: false }),
  });
  await view.rowState("t1", "proposed");
  expect(view.$<HTMLInputElement>("#ws-worktree").disabled).toBe(true);

  view.$("#refresh").click();
  (await view.nextCall("read")).resolve({ data: planData([task("t1", "Review tests")]) });
  await vi.waitFor(() => expect(view.$<HTMLInputElement>("#ws-worktree").disabled).toBe(false));

  view.$("#ws-worktree").click();
  expect(view.$<HTMLInputElement>("#base-ref").value).toBe("");
  expect(startButton(view, "t1")!.disabled).toBe(true);
  expect(view.$("#start-hint").textContent).toContain("base branch");

  view.type("#base-ref", "  release/2.0 ");
  expect(startButton(view, "t1")!.disabled).toBe(false);
  startButton(view, "t1")!.click();
  expect((await view.nextCall("start")).input).toMatchObject({
    workspaceStrategy: { type: "worktree", baseRef: "release/2.0" },
  });
});

it("loads models only when the picker opens, page by page, and starts with the chosen one", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({ data: planData([task("t1", "Review tests")]) });
  await view.rowState("t1", "proposed");
  expect(view.$("#model-name").textContent).toContain("gpt-5-codex");

  view.$("#model-toggle").click();
  const first = await view.nextCall("models");
  expect(first.input).toEqual({});
  first.resolve({
    data: {
      models: [
        {
          modelSelection: DEFAULTS.modelSelection,
          title: "GPT-5 Codex",
          providerTitle: "Codex",
          options: [],
        },
      ],
      nextCursor: 50,
    },
  });
  await vi.waitFor(() => expect(view.doc().querySelectorAll("#model-list input")).toHaveLength(1));
  expect(view.$<HTMLInputElement>("#model-list input").checked).toBe(true);

  view.$("#model-more").click();
  const second = await view.nextCall("models");
  expect(second.input).toEqual({ cursor: 50 });
  const opus = { instanceId: "claude", model: "claude-opus-5-5" };
  second.resolve({
    data: {
      models: [{ modelSelection: opus, title: "Opus 5.5", providerTitle: "Claude", options: [] }],
      nextCursor: null,
    },
  });
  await vi.waitFor(() => expect(view.doc().querySelectorAll("#model-list input")).toHaveLength(2));
  expect(view.$("#model-more").hidden).toBe(true);

  view.doc().querySelectorAll<HTMLInputElement>("#model-list input")[1]!.click();
  expect(view.$("#model-name").textContent).toBe("Opus 5.5 · Claude");
  startButton(view, "t1")!.click();
  expect((await view.nextCall("start")).input).toMatchObject({ modelSelection: opus });
});

it("rereads on its own change signal and keeps the person's unsaved settings", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")]),
  });
  await view.rowState("t1", "proposed");
  view.choose("#runtime", "auto");
  view.$("#ws-worktree").click();
  view.type("#base-ref", "main");

  view.host.changed("view:tasks");
  view.host.changed("status:tasks");
  view.host.changed("view:launcher");
  const reread = await view.nextCall("read");
  reread.resolve({
    data: planData([
      task("t1", "Review tests", { state: "started", threadId: "thread-a" }),
      task("t2", "Fix flaky test"),
    ]),
  });
  await view.rowState("t1", "started");
  // Only this view's topic rereads.
  expect(view.calls).toEqual([]);
  expect(view.$<HTMLSelectElement>("#runtime").value).toBe("auto");
  expect(view.$<HTMLInputElement>("#ws-worktree").checked).toBe(true);
  expect(view.$<HTMLInputElement>("#base-ref").value).toBe("main");

  startButton(view, "t2")!.click();
  expect((await view.nextCall("start")).input).toMatchObject({
    taskId: "t2",
    runtimeMode: "auto",
    workspaceStrategy: { type: "worktree", baseRef: "main" },
  });
});

it("rereads after a read or a start that a change signal overtook", async () => {
  using view = mountView(sidePanel);
  const initial = await view.nextCall("read");
  // The side panel names no plan: the backend picks the latest for the verified thread.
  expect(initial.input).toEqual({});
  initial.resolve({ data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")]) });
  await view.rowState("t1", "proposed");

  view.$("#refresh").click();
  const older = await view.nextCall("read");
  view.host.changed("view:tasks");
  // A signal during a read waits for it, since that answer may predate the change.
  older.resolve({ data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")]) });
  const newer = await view.nextCall("read");
  newer.resolve({
    data: planData([
      task("t1", "Review tests", { state: "started", threadId: "thread-a" }),
      task("t2", "Fix flaky test"),
    ]),
  });
  await view.rowState("t1", "started");

  startButton(view, "t2")!.click();
  const start = await view.nextCall("start");
  view.host.changed("view:tasks");
  start.resolve({
    data: {
      ...planData([
        task("t1", "Review tests", { state: "started", threadId: "thread-a" }),
        task("t2", "Fix flaky test", { state: "started", threadId: "thread-b" }),
      ]),
      results: [{ taskId: "t2", state: "started", threadId: "thread-b" }],
    },
  });
  await view.rowState("t2", "started");
  const after = await view.nextCall("read");
  after.resolve({ data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")]) });
  await view.rowState("t2", "proposed");
});

it("ignores a late answer for the thread the side panel just left", async () => {
  using view = mountView(sidePanel);
  const forFirst = await view.nextCall("read");
  view.setContext({ ...sidePanel, thread: { threadId: "thread-2", projectId: "project-1" } });
  const forSecond = await view.nextCall("read");
  forSecond.resolve({ data: { plan: null, canStart: true, canWorktree: true } });
  await vi.waitFor(() => expect(view.$("#placeholder").textContent).toContain("No task proposals"));
  forFirst.resolve({ data: planData([task("t1", "Review tests")]) });
  // The bridge delivers in order, so by the next signal's read the late answer was handled.
  view.host.changed("view:tasks");
  const again = await view.nextCall("read");
  expect(view.doc().querySelectorAll("#tasks li")).toHaveLength(0);
  again.resolve({ data: { plan: null, canStart: true, canWorktree: true } });
});

it("explains missing permission and an unavailable proposal in plain text", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests")], { canStart: false }),
  });
  await view.rowState("t1", "proposed");
  expect(startButton(view, "t1")!.disabled).toBe(true);
  expect(view.$("#start-hint").textContent).toContain("not allowed to start threads");

  view.$("#refresh").click();
  (await view.nextCall("read")).reject(
    new Error("This plan is unavailable or was removed from bounded storage."),
  );
  await vi.waitFor(() =>
    expect(view.$("#failure-text").textContent).toBe(
      "This plan is unavailable or was removed from bounded storage.",
    ),
  );
  expect(view.doc().querySelectorAll("#tasks li")).toHaveLength(0);
  // The card's recorded summary stays readable, marked as history.
  expect(view.$("#recorded").textContent).toContain("Proposed 3 tasks. Review before starting.");
});

it("works on an older client without change signals or local intents", async () => {
  using view = mountView({ ...sidePanel, features: [] });
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests", { state: "started", threadId: "thread-a" })]),
  });
  await view.rowState("t1", "started");
  expect(view.row("t1").querySelector('button[data-action="open"]')).toBeNull();
  expect(view.row("t1").textContent).toContain("Find “Review tests” in the sidebar");
  expect(view.$<HTMLButtonElement>("#refresh").disabled).toBe(false);
});

it("asks nothing without a thread", async () => {
  using view = mountView({ ...sidePanel, thread: null });
  await vi.waitFor(() =>
    expect(view.$("#placeholder").textContent).toContain("Open Task Launcher beside a thread"),
  );
  expect(view.calls).toEqual([]);
});
