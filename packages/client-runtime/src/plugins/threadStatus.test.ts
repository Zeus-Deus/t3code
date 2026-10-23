import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PluginInstallation,
  type PluginInvokeInput,
  type PluginInvokeResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { pluginThreadStatusEntries } from "./model.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";
import {
  createPluginThreadStatusPoller,
  notifyPluginThreadActivity,
  PLUGIN_THREAD_STATUS_ACTIVITY_SETTLE_MS,
  PLUGIN_THREAD_STATUS_INTERVAL_MS,
  pluginThreadStatusesFor,
  type PluginThreadStatusTarget,
} from "./threadStatus.ts";

const environmentId = EnvironmentId.make("env-1");
const threadA: PluginThreadStatusTarget = {
  environmentId,
  threadId: ThreadId.make("thread-a"),
  projectId: ProjectId.make("project-1"),
};
const threadB: PluginThreadStatusTarget = {
  environmentId,
  threadId: ThreadId.make("thread-b"),
  projectId: null,
};

const realms = (generation = "gen-1"): PluginInstallation => {
  const base = pluginInstallationFixture({ generation });
  return {
    ...base,
    manifest: {
      ...base.manifest,
      name: "Realms",
      views: [{ id: "realm", title: "Realm", entry: "realm.html", placement: "side-panel" }],
      threadStatus: [{ id: "realm", title: "Realm", viewId: "realm" }],
    },
  };
};

interface Call {
  readonly input: PluginInvokeInput;
  readonly resolve: (result: PluginInvokeResult) => Promise<void>;
  readonly reject: () => Promise<void>;
}

function setup() {
  vi.useFakeTimers();
  const calls: Call[] = [];
  const poller = createPluginThreadStatusPoller({
    operationId: () => `op-${calls.length}`,
    invoke: ({ input }) => {
      let resolve!: (result: PluginInvokeResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<PluginInvokeResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Awaiting the same promise after the poller's own handler means its answer has applied.
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      calls.push({
        input,
        resolve: (result) => {
          resolve(result);
          return settled;
        },
        reject: () => {
          reject(new Error("worker failed"));
          return settled;
        },
      });
      return promise;
    },
  });
  const labels = () => poller.getSnapshot().map((value) => value.status.label);
  return {
    poller,
    calls,
    labels,
    [Symbol.dispose]: () => {
      poller.dispose();
      vi.useRealTimers();
    },
  };
}

const live = { data: { label: "Realm live", tone: "success", detail: "1920x1080 desktop." } };

describe("createPluginThreadStatusPoller", () => {
  it("asks the open thread's status and hides it on null or failure", async () => {
    using t = setup();
    const entries = pluginThreadStatusEntries([realms()]);
    t.poller.update({ target: threadA, entries, visible: true });

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.input).toMatchObject({
      installationId: "inst-1",
      generation: "gen-1",
      handler: "status:realm",
      context: { threadId: "thread-a", projectId: "project-1" },
    });
    await t.calls[0]!.resolve(live);
    expect(t.labels()).toEqual(["Realm live"]);

    t.poller.refresh();
    await t.calls[1]!.resolve({ data: null });
    expect(t.labels()).toEqual([]);

    t.poller.refresh();
    await t.calls[2]!.resolve(live);
    t.poller.refresh();
    await t.calls[3]!.reject();
    expect(t.labels()).toEqual([]);
  });

  it("ignores answers that are not a status", async () => {
    using t = setup();
    t.poller.update({
      target: threadA,
      entries: pluginThreadStatusEntries([realms()]),
      visible: true,
    });
    await t.calls[0]!.resolve({ data: { label: "", tone: "loud" } });
    expect(t.labels()).toEqual([]);
  });

  it("keeps one request in flight and asks once more after it answers", async () => {
    using t = setup();
    const entries = pluginThreadStatusEntries([realms()]);
    t.poller.update({ target: threadA, entries, visible: true });
    t.poller.refresh();
    t.poller.refresh();
    t.poller.update({ target: threadA, entries, visible: true });
    expect(t.calls).toHaveLength(1);

    await t.calls[0]!.resolve({ data: null });
    expect(t.calls).toHaveLength(2);
    await t.calls[1]!.resolve(live);
    expect(t.calls).toHaveLength(2);
    expect(t.labels()).toEqual(["Realm live"]);
  });

  it("never shows a status for a thread that is no longer open", async () => {
    using t = setup();
    const entries = pluginThreadStatusEntries([realms()]);
    t.poller.update({ target: threadA, entries, visible: true });
    await t.calls[0]!.resolve(live);
    expect(t.labels()).toEqual(["Realm live"]);

    t.poller.update({ target: threadB, entries, visible: true });
    expect(t.labels()).toEqual([]);
    expect(t.calls[1]!.input.context).toEqual({ threadId: "thread-b" });

    // A slow answer for A arrives while B is open.
    t.poller.update({ target: threadA, entries, visible: true });
    t.poller.update({ target: threadB, entries, visible: true });
    const lateForA = t.calls[2]!;
    expect(lateForA.input.context?.threadId).toBe("thread-a");
    await lateForA.resolve(live);
    expect(t.labels()).toEqual([]);

    await t.calls[1]!.resolve({ data: { label: "Realm off", tone: "neutral" } });
    expect(t.poller.getSnapshot().map((value) => [value.threadId, value.status.label])).toEqual([
      ["thread-b", "Realm off"],
    ]);
  });

  it("drops a revoked or replaced generation at once and ignores its late answer", async () => {
    using t = setup();
    t.poller.update({
      target: threadA,
      entries: pluginThreadStatusEntries([realms("gen-1")]),
      visible: true,
    });
    await t.calls[0]!.resolve(live);

    t.poller.refresh();
    const stale = t.calls[1]!;
    t.poller.update({
      target: threadA,
      entries: pluginThreadStatusEntries([realms("gen-2")]),
      visible: true,
    });
    expect(t.labels()).toEqual([]);
    expect(t.calls[2]!.input.generation).toBe("gen-2");
    await stale.resolve(live);
    expect(t.labels()).toEqual([]);

    await t.calls[2]!.resolve(live);
    expect(t.labels()).toEqual(["Realm live"]);
    t.poller.update({
      target: threadA,
      entries: pluginThreadStatusEntries([{ ...realms("gen-2"), enabled: false }]),
      visible: true,
    });
    expect(t.labels()).toEqual([]);
  });

  it("polls on an interval only while visible, and catches up when it is again", async () => {
    using t = setup();
    const entries = pluginThreadStatusEntries([realms()]);
    t.poller.update({ target: threadA, entries, visible: true });
    await t.calls[0]!.resolve(live);

    vi.advanceTimersByTime(PLUGIN_THREAD_STATUS_INTERVAL_MS);
    expect(t.calls).toHaveLength(2);
    await t.calls[1]!.resolve(live);

    t.poller.update({ target: threadA, entries, visible: false });
    vi.advanceTimersByTime(PLUGIN_THREAD_STATUS_INTERVAL_MS * 3);
    t.poller.refresh();
    expect(t.calls).toHaveLength(2);
    // The last value stays while hidden; nothing new is asked until the thread is seen again.
    expect(t.labels()).toEqual(["Realm live"]);

    t.poller.update({ target: threadA, entries, visible: true });
    expect(t.calls).toHaveLength(3);
  });

  it("does not ask for a thread nobody is looking at", () => {
    using t = setup();
    t.poller.update({
      target: threadA,
      entries: pluginThreadStatusEntries([realms()]),
      visible: false,
    });
    vi.advanceTimersByTime(PLUGIN_THREAD_STATUS_INTERVAL_MS * 2);
    t.poller.update({ target: null, entries: [], visible: true });
    vi.advanceTimersByTime(PLUGIN_THREAD_STATUS_INTERVAL_MS * 2);
    expect(t.calls).toHaveLength(0);
  });

  it("settles a burst of plugin activity on the open thread into one request", async () => {
    using t = setup();
    t.poller.update({
      target: threadA,
      entries: pluginThreadStatusEntries([realms()]),
      visible: true,
    });
    await t.calls[0]!.resolve({ data: null });

    const activity = { environmentId, threadId: threadA.threadId, installationId: "inst-1" };
    notifyPluginThreadActivity(activity);
    notifyPluginThreadActivity(activity);
    notifyPluginThreadActivity({ ...activity, threadId: threadB.threadId });
    notifyPluginThreadActivity({ ...activity, installationId: "inst-other" });
    expect(t.calls).toHaveLength(1);

    vi.advanceTimersByTime(PLUGIN_THREAD_STATUS_ACTIVITY_SETTLE_MS);
    expect(t.calls).toHaveLength(2);
    await t.calls[1]!.resolve(live);
    expect(t.labels()).toEqual(["Realm live"]);
  });
});

describe("pluginThreadStatusesFor", () => {
  it("shows only values for the target and entries being rendered", async () => {
    using t = setup();
    const entries = pluginThreadStatusEntries([realms()]);
    t.poller.update({ target: threadA, entries, visible: true });
    await t.calls[0]!.resolve(live);
    const values = t.poller.getSnapshot();

    expect(pluginThreadStatusesFor(values, threadA, entries)).toBe(values);
    expect(pluginThreadStatusesFor(values, threadB, entries)).toEqual([]);
    expect(
      pluginThreadStatusesFor(values, threadA, pluginThreadStatusEntries([realms("gen-2")])),
    ).toEqual([]);
    expect(pluginThreadStatusesFor(values, null, entries)).toEqual([]);
  });
});
