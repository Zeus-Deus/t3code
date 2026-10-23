import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  makePluginViewHost,
  type PluginViewBridgeFeature,
} from "@t3tools/client-runtime/plugins";
import type { PluginClientIntent } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

/** Mounts one view document in an opaque sandbox, as the app does, and reports what it saw. */
function mountView(input: {
  readonly token: string;
  readonly html: string;
  readonly features: ReadonlyArray<PluginViewBridgeFeature>;
}) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  const intents: PluginClientIntent[] = [];
  const heights: number[] = [];
  const reports: unknown[] = [];
  const channel = bindPluginViewChannel({
    token: input.token,
    source: () => frame.contentWindow,
    receive: (message) => host.receive(message),
  });
  const host = makePluginViewHost({
    token: input.token,
    post: channel.post,
    context: () => ({
      theme: "light",
      styles: {},
      platform: "web",
      placement: "conversation",
      view: { installationId: "inst", viewId: "task" },
      thread: null,
      features: input.features,
      card: { viewId: "task", summary: "Plan", data: { planId: "plan-1" } },
    }),
    captureOrigin: () => null,
    invoke: async () => ({ data: { reads: 1 } }),
    onIntents: (next) => intents.push(...next),
    features: input.features,
    onResize: (height) => heights.push(height),
  });
  const onMessage = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && event.data?.report !== undefined) {
      reports.push(event.data.report);
    }
  };
  window.addEventListener("message", onMessage);
  frame.srcdoc = buildPluginViewDocument(input.html, input.token, input.features);
  document.body.append(frame);
  return {
    host,
    intents,
    heights,
    reports,
    [Symbol.dispose]: () => {
      window.removeEventListener("message", onMessage);
      host.dispose();
      channel.dispose();
      frame.remove();
    },
  };
}

// The view reports to the harness on the parent window; the host ignores messages without its token.
const report = (expression: string) => `parent.postMessage({report:${expression}},"*");`;

it("gives a card its features, change signals, local intents and content height", async () => {
  using view = mountView({
    token: "card-document",
    features: ["changes", "local-intents", "resize", "card-context"],
    html: `<style>body{margin:0}</style><div style="height:180px">Plan</div><script>
      t3.ready.then(function (context) {
        ${report("{features:t3.features.slice(),card:context.card}")}
        t3.onChanged(function (change) {
          t3.invoke("read").then(function (result) { ${report("{changed:change.topic,reads:result.data.reads}")} });
        });
        t3.intent({type:"view.open",viewId:"board"}).then(function () { ${report("{intent:'sent'}")} });
      });
    </script>`,
  });

  await expect
    .poll(() => view.reports[0])
    .toEqual({
      features: ["changes", "local-intents", "resize", "card-context"],
      card: { viewId: "task", summary: "Plan", data: { planId: "plan-1" } },
    });
  await expect.poll(() => view.intents).toEqual([{ type: "view.open", viewId: "board" }]);
  await expect.poll(() => view.heights.at(-1)).toBe(180);

  view.host.changed("view:task");
  await expect.poll(() => view.reports).toContainEqual({ changed: "view:task", reads: 1 });
});

it("serves an older-style document without the new methods", async () => {
  using view = mountView({
    token: "page-document",
    features: [],
    html: `<script>
      t3.ready.then(function () {
        ${report("{features:t3.features.length,onChanged:typeof t3.onChanged,intent:typeof t3.intent,resize:typeof t3.resize}")}
      });
    </script>`,
  });
  await expect
    .poll(() => view.reports[0])
    .toEqual({ features: 0, onChanged: "undefined", intent: "undefined", resize: "undefined" });
  // Signals for a document built without them never reach it.
  view.host.changed("view:task");
  expect(view.heights).toEqual([]);
});
