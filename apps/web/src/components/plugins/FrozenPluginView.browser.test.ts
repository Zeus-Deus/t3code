import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  makePluginViewHost,
} from "@t3tools/client-runtime/plugins";
import { expect, it } from "vite-plus/test";

import frozenView from "../../../../server/src/plugins/fixtures/frozen-v1/view.html?raw";

it("keeps the frozen v1 view bridge usable inside an opaque sandbox", async () => {
  const token = "frozen-v1-document";
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  using _frame = { [Symbol.dispose]: () => frame.remove() };
  const channel = bindPluginViewChannel({
    token,
    source: () => frame.contentWindow,
    receive: (message) => host.receive(message),
  });
  using _channel = { [Symbol.dispose]: () => channel.dispose() };
  const host = makePluginViewHost({
    token,
    post: channel.post,
    context: () => ({
      theme: "light",
      styles: {},
      platform: "web",
      placement: "page",
      view: { installationId: "frozen-v1", viewId: "summary" },
      thread: null,
    }),
    captureOrigin: () => null,
    invoke: async (name) => {
      if (name !== "read") throw new Error("Unexpected frozen view handler");
      return { data: { title: "Existing thread" } };
    },
    onIntents: () => {},
  });
  using _host = { [Symbol.dispose]: () => host.dispose() };
  let receive!: (event: MessageEvent) => void;
  const observed = new Promise<string>((resolve) => {
    receive = (event) => {
      if (event.source === frame.contentWindow && typeof event.data?.frozenViewUpdated === "string")
        resolve(event.data.frozenViewUpdated);
    };
    window.addEventListener("message", receive);
  });
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", receive) };
  // The harness observes the old document from inside its opaque origin; its bytes stay frozen.
  const observer = `<script>
    t3.ready.then(function () {
      var summary = document.getElementById("summary");
      var observer = new MutationObserver(function () {
        parent.postMessage({frozenViewUpdated:summary.textContent}, "*");
        observer.disconnect();
      });
      observer.observe(summary, {childList:true});
      summary.click();
    });
  </script>`;
  frame.srcdoc = buildPluginViewDocument(frozenView + observer, token);
  document.body.append(frame);

  expect(await observed).toBe("Existing thread");
});
