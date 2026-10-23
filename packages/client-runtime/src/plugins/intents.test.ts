import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  planPluginIntents,
  pluginUnsupportedIntentCount,
  type PluginInvocationOrigin,
} from "./intents.ts";

const origin: PluginInvocationOrigin = {
  environmentId: EnvironmentId.make("env-1"),
  installationId: "inst-1",
  locationKey: "/env-1/thread-a",
  composerKey: "env-1:thread-a",
  threadId: ThreadId.make("thread-a"),
};
const manifest = {
  views: [{ id: "board", title: "Board", entry: "view.html", placement: "page" as const }],
};

describe("planPluginIntents", () => {
  it("inserts into the composer the action was invoked from, even after the user moved on", () => {
    const steps = planPluginIntents({
      origin,
      manifest,
      intents: [{ type: "composer.insert", text: "one\n\ntwo", quote: true }],
      currentLocationKey: "/env-1/thread-b",
      canOpenPreview: true,
    });
    expect(steps).toEqual([
      { kind: "insert", composerKey: "env-1:thread-a", text: "> one\n>\n> two", visible: false },
    ]);
  });

  it("offers navigation instead of moving a user who left the origin", () => {
    const steps = planPluginIntents({
      origin,
      manifest,
      intents: [{ type: "thread.reveal", threadId: ThreadId.make("thread-c") }],
      currentLocationKey: "/settings/plugins",
      canOpenPreview: true,
    });
    expect(steps).toMatchObject([{ kind: "navigate", mode: "offer" }]);
  });

  it("applies at most one navigation while the user stays put", () => {
    const steps = planPluginIntents({
      origin,
      manifest,
      intents: [
        { type: "preview.open", url: "https://tickets.example/T-1" },
        { type: "view.open", viewId: "board" },
      ],
      currentLocationKey: origin.locationKey,
      canOpenPreview: true,
    });
    expect(steps.map((step) => (step.kind === "navigate" ? step.mode : step.kind))).toEqual([
      "apply",
      "offer",
    ]);
  });

  it("says where inserted text went when the same result moves the user away from it", () => {
    const visibility = (intents: Parameters<typeof planPluginIntents>[0]["intents"]) =>
      planPluginIntents({
        origin,
        manifest: {
          views: [
            ...manifest.views,
            { id: "notes", title: "Notes", entry: "notes.html", placement: "side-panel" },
          ],
        },
        intents,
        currentLocationKey: origin.locationKey,
        canOpenPreview: true,
      }).flatMap((step) => (step.kind === "insert" ? [step.visible] : []));
    const insert = { type: "composer.insert" as const, text: "draft" };

    expect(
      visibility([{ type: "thread.reveal", threadId: ThreadId.make("thread-b") }, insert]),
    ).toEqual([false]);
    expect(visibility([insert, { type: "view.open", viewId: "board" }])).toEqual([false]);
    // These keep the user on the thread whose composer got the text.
    expect(
      visibility([{ type: "thread.reveal", threadId: ThreadId.make("thread-a") }, insert]),
    ).toEqual([true]);
    expect(visibility([{ type: "view.open", viewId: "notes" }, insert])).toEqual([true]);
    expect(
      visibility([{ type: "preview.open", url: "https://tickets.example/T-1" }, insert]),
    ).toEqual([true]);
  });

  it("offers a preview link when there is no thread to open it beside", () => {
    const steps = planPluginIntents({
      origin: { ...origin, threadId: null, composerKey: null },
      manifest,
      intents: [{ type: "preview.open", url: "https://tickets.example/T-1" }],
      currentLocationKey: origin.locationKey,
      canOpenPreview: true,
    });
    expect(steps).toMatchObject([{ kind: "navigate", mode: "offer" }]);
  });

  it("rejects undeclared views and inserts without a composer", () => {
    const steps = planPluginIntents({
      origin: { ...origin, composerKey: null },
      manifest,
      intents: [
        { type: "view.open", viewId: "settings-hijack" },
        { type: "composer.insert", text: "hello" },
      ],
      currentLocationKey: origin.locationKey,
      canOpenPreview: true,
    });
    expect(steps.map((step) => step.kind)).toEqual(["rejected", "rejected"]);
  });
});

describe("pluginUnsupportedIntentCount", () => {
  it("counts intents a newer plugin API sent, and nothing for older servers", () => {
    expect(pluginUnsupportedIntentCount({ message: "done" })).toBe(0);
    expect(pluginUnsupportedIntentCount({ intents: [], unsupportedIntentCount: 2 } as never)).toBe(
      2,
    );
    expect(pluginUnsupportedIntentCount({ unsupportedIntentCount: -1 } as never)).toBe(0);
  });

  it("does not open a card's conversation view as a page", () => {
    const steps = planPluginIntents({
      origin,
      manifest: {
        views: [{ id: "card", title: "Task", entry: "card.html", placement: "conversation" }],
      },
      intents: [{ type: "view.open", viewId: "card" }],
      currentLocationKey: origin.locationKey,
      canOpenPreview: true,
    });
    expect(steps).toMatchObject([{ kind: "rejected" }]);
  });
});
