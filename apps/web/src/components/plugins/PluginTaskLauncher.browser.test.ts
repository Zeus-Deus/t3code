import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  makePluginViewHost,
  type PluginViewBridgeFeature,
  type PluginViewContext,
} from "@t3tools/client-runtime/plugins";
import type { PluginClientIntent, PluginInvokeResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import viewHtml from "../../../../server/src/plugins/fixtures/consumers/task-launcher/view.html?raw";

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
  | {
      state: "uncertain" | "pending" | "starting" | "abandoned";
      diagnostic?: string;
      choices?: unknown;
    };

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
 * Mounts the consumer fixture behind the real bridge with the features the context lists. The frame
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
const rowButton = (view: ReturnType<typeof mountView>, taskId: string, action: string) =>
  view.row(taskId).querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
const ABANDONED =
  "Launch acknowledged and retired. A thread may already exist; this does not cancel or delete it. Proposing a new plan may duplicate that work.";

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

it("abandons an uncertain task only after a confirmation that names the thread to look for", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test"),
      task("t3", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN }),
    ]),
  });
  await view.rowState("t3", "uncertain");
  expect(rowButton(view, "t1", "acknowledge")).toBeNull();
  view.choose("#runtime", "auto");

  rowButton(view, "t3", "acknowledge")!.focus();
  rowButton(view, "t3", "acknowledge")!.click();
  const confirm = view.row("t3").querySelector(".confirm")!;
  // Keyboard focus moves to the safe choice, not to the confirmation.
  expect(view.doc().activeElement).toBe(rowButton(view, "t3", "acknowledge-cancel"));
  expect(confirm.textContent).toContain("“[Task Launcher] Update docs”");
  expect(confirm.textContent).toContain("doesn't cancel or delete");
  expect(confirm.textContent).toContain("duplicate");
  // Backing out sends nothing.
  rowButton(view, "t3", "acknowledge-cancel")!.click();
  expect(view.row("t3").querySelector(".confirm")).toBeNull();
  expect(view.calls).toEqual([]);

  rowButton(view, "t3", "acknowledge")!.click();
  rowButton(view, "t3", "acknowledge-confirm")!.click();
  const acknowledge = await view.nextCall("acknowledge");
  expect(acknowledge.input).toEqual({ planId: "plan-1", taskId: "t3", confirmUncertain: true });
  await vi.waitFor(() => expect(startButton(view, "t1")!.disabled).toBe(true));
  expect(view.$<HTMLButtonElement>("#start-all").disabled).toBe(true);
  expect(rowButton(view, "t3", "acknowledge-confirm")!.disabled).toBe(true);
  // A signal during the acknowledgement waits for its answer.
  view.host.changed("view:launcher");
  await Promise.resolve();
  expect(view.calls).toEqual([]);

  acknowledge.resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test"),
      task("t3", "Update docs", {
        state: "abandoned",
        diagnostic: ABANDONED,
        choices: { ...DEFAULTS, workspaceStrategy: { type: "root" } },
      }),
    ]),
  });
  await view.rowState("t3", "abandoned");
  expect(view.row("t3").querySelector(".state")!.textContent).toBe("Abandoned");
  expect(view.row("t3").querySelector(".diagnostic")!.textContent).toBe(ABANDONED);
  expect(view.row("t3").querySelector(".confirm")).toBeNull();
  expect(startButton(view, "t3")).toBeNull();
  expect(rowButton(view, "t3", "acknowledge")).toBeNull();
  expect(view.$("#tally").textContent).toBe("2 not started · 1 abandoned");
  expect(view.$("#status").textContent).toContain("not cancelled");
  // Abandoned work is never part of Start all, and the unsaved settings survived.
  expect(view.$("#start-all").textContent).toBe("Start 2 tasks");
  expect(view.$<HTMLSelectElement>("#runtime").value).toBe("auto");

  const reread = await view.nextCall("read");
  expect(reread.input).toEqual({ planId: "plan-1" });
  reread.resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test"),
      task("t3", "Update docs", { state: "abandoned", diagnostic: ABANDONED }),
    ]),
  });
  await vi.waitFor(() => expect(view.$<HTMLButtonElement>("#start-all").disabled).toBe(false));
  view.$("#start-all").click();
  const startAll = await view.nextCall("startAll");
  expect(startAll.input).toMatchObject({
    choices: [
      { taskId: "t1", runtimeMode: "auto" },
      { taskId: "t2", runtimeMode: "auto" },
    ],
  });
});

it("shows a refused acknowledgement as is, rereads, and never sends it again", async () => {
  using view = mountView(sidePanel);
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN })]),
  });
  await view.rowState("t1", "uncertain");
  rowButton(view, "t1", "acknowledge")!.click();
  rowButton(view, "t1", "acknowledge-confirm")!.click();
  const acknowledge = await view.nextCall("acknowledge");
  expect(acknowledge.input).toEqual({ planId: "plan-1", taskId: "t1", confirmUncertain: true });

  acknowledge.reject(new Error("Only uncertain launches can be acknowledged."));
  const reread = await view.nextCall("read");
  await vi.waitFor(() =>
    expect(view.$("#failure-text").textContent).toBe(
      "Only uncertain launches can be acknowledged.",
    ),
  );
  expect(view.$("#status").textContent).toBe("");
  reread.resolve({
    data: planData([task("t1", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN })]),
  });
  await vi.waitFor(() => expect(rowButton(view, "t1", "acknowledge")!.disabled).toBe(false));
  expect(view.row("t1").dataset.state).toBe("uncertain");
  expect(view.row("t1").querySelector(".confirm")).toBeNull();
  expect(view.calls).toEqual([]);
});

it("drops an acknowledgement answer for a card the view has left", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN })]),
  });
  await view.rowState("t1", "uncertain");
  rowButton(view, "t1", "acknowledge")!.click();
  rowButton(view, "t1", "acknowledge-confirm")!.click();
  const acknowledge = await view.nextCall("acknowledge");

  const other = card(CARD_FEATURES);
  view.setContext({ ...other, card: { ...other.card!, data: { planId: "plan-2" } } });
  const read = await view.nextCall("read");
  expect(read.input).toEqual({ planId: "plan-2" });
  read.resolve({
    data: planData([task("t1", "Update docs", { state: "uncertain", diagnostic: UNCERTAIN })]),
  });
  await view.rowState("t1", "uncertain");
  acknowledge.resolve({
    data: planData([task("t1", "Update docs", { state: "abandoned", diagnostic: ABANDONED })]),
  });
  // The bridge delivers in order, so by the next signal's read the late answer was handled.
  view.host.changed("view:launcher");
  const again = await view.nextCall("read");
  expect(view.row("t1").dataset.state).toBe("uncertain");
  expect(view.row("t1").querySelector(".confirm")).toBeNull();
  expect(view.$("#status").textContent).toBe("");
  again.resolve({ data: { plan: null, canStart: true, canWorktree: true } });
});

it("never offers Start or abandonment for a task another view is starting or one already abandoned", async () => {
  using view = mountView(sidePanel);
  (await view.nextCall("read")).resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test", { state: "starting" }),
      task("t3", "Update docs", { state: "abandoned" }),
      task("t4", "Bump deps"),
    ]),
  });
  await view.rowState("t2", "starting");
  expect(view.row("t2").querySelector(".state")!.textContent).toBe("Starting…");
  expect(view.row("t3").dataset.state).toBe("abandoned");
  // Without the backend's text, an abandoned task still says the thread was not cancelled.
  expect(view.row("t3").querySelector(".diagnostic")!.textContent).toContain(
    "“[Task Launcher] Update docs”",
  );
  for (const id of ["t2", "t3"]) {
    expect(startButton(view, id)).toBeNull();
    expect(rowButton(view, id, "acknowledge")).toBeNull();
  }
  expect(view.$("#tally").textContent).toBe("2 not started · 1 starting · 1 abandoned");
  view.$("#start-all").click();
  expect((await view.nextCall("startAll")).input).toMatchObject({
    choices: [{ taskId: "t1" }, { taskId: "t4" }],
  });
});

it("warns before starting several tasks in one project folder without choosing a worktree for the person", async () => {
  using view = mountView(card(CARD_FEATURES));
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")]),
  });
  await view.rowState("t1", "proposed");
  expect(view.$<HTMLInputElement>("#ws-root").checked).toBe(true);
  expect(view.$("#share-warning").hidden).toBe(false);
  expect(view.$("#share-warning").textContent).toContain("same project folder");
  expect(view.$("#share-warning").textContent).toContain("New worktree");

  view.$("#ws-worktree").click();
  expect(view.$("#share-warning").hidden).toBe(true);
  // No base is guessed for the person.
  expect(view.$<HTMLInputElement>("#base-ref").value).toBe("");
  expect(view.$<HTMLButtonElement>("#start-all").disabled).toBe(true);

  view.$("#ws-root").click();
  view.$("#refresh").click();
  (await view.nextCall("read")).resolve({
    data: planData([task("t1", "Review tests"), task("t2", "Fix flaky test")], {
      canWorktree: false,
    }),
  });
  await vi.waitFor(() => expect(view.$<HTMLInputElement>("#ws-worktree").disabled).toBe(true));
  expect(view.$("#share-warning").hidden).toBe(false);
  expect(view.$("#share-warning").textContent).not.toContain("New worktree");

  view.$("#refresh").click();
  (await view.nextCall("read")).resolve({
    data: planData([
      task("t1", "Review tests"),
      task("t2", "Fix flaky test", { state: "started", threadId: "thread-b" }),
    ]),
  });
  // One task left: nothing to share.
  await view.rowState("t2", "started");
  expect(view.$("#share-warning").hidden).toBe(true);
});
