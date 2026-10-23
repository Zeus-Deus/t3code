import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  makePluginViewHost,
  pluginViewOuterDocument,
} from "@t3tools/client-runtime/plugins";
import type { PluginInvokeResult } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

const TOKEN = "document-token";

// The page the view navigates to: it never saw the token, and it reports every message it gets.
const REPLACEMENT = `data:text/html,${encodeURIComponent(`<script>
  var seen = [];
  window.addEventListener("message", function (e) {
    if (e.data && e.data.report) parent.postMessage({ replacementSaw: seen }, "*");
    else seen.push(e.data);
  });
  parent.postMessage({ replacementReady: true }, "*");
</script>`)}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextMessage<T>(match: (data: Record<string, unknown>) => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const found = event.data && typeof event.data === "object" ? match(event.data) : undefined;
      if (found === undefined) return;
      window.removeEventListener("message", listener);
      resolve(found);
    };
    window.addEventListener("message", listener);
  });
}

it("keeps a pending result from a page the view navigated to while its load is pending", async () => {
  let answer!: (result: PluginInvokeResult) => void;
  const invoked = deferred();
  const answered = deferred();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  using _frame = { [Symbol.dispose]: () => frame.remove() };
  const channel = bindPluginViewChannel({
    token: TOKEN,
    source: () => frame.contentWindow,
    receive: (data) => host.receive(data),
  });
  using _channel = { [Symbol.dispose]: () => channel.dispose() };
  const host = makePluginViewHost({
    token: TOKEN,
    post: (message) => {
      channel.post(message);
      if ((message as { kind?: unknown }).kind === "result") answered.resolve();
    },
    context: () => ({
      theme: "dark",
      styles: {},
      platform: "web",
      placement: "page",
      view: { installationId: "inst-1", viewId: "board" },
      thread: { threadId: "private-thread", projectId: null },
    }),
    captureOrigin: () => null,
    invoke: () => {
      invoked.resolve();
      return new Promise<PluginInvokeResult>((resolve) => {
        answer = resolve;
      });
    },
    onIntents: () => undefined,
  });
  // The view asks a private handler, then leaves before the answer arrives.
  frame.srcdoc = buildPluginViewDocument(
    `<script>t3.invoke("secret").catch(function () {});
      t3.ready.then(function () { location.href = ${JSON.stringify(REPLACEMENT)}; });</script>`,
    TOKEN,
  );
  const replacementReady = nextMessage((data) => (data.replacementReady ? true : undefined));
  document.body.append(frame);
  await invoked.promise;
  await replacementReady;

  // The host has not seen a second load yet: it answers and resends context as it would.
  host.sendContext();
  answer({ data: { secret: "board items" } });
  await answered.promise;
  const saw = nextMessage((data) =>
    Array.isArray(data.replacementSaw) ? data.replacementSaw : undefined,
  );
  frame.contentWindow!.postMessage({ report: true }, "*");

  expect(await saw).toEqual([]);
});

it("binds only the first hand-over that carries this document's token", async () => {
  const received: unknown[] = [];
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  using _frame = { [Symbol.dispose]: () => frame.remove() };
  const channel = bindPluginViewChannel({
    token: TOKEN,
    source: () => frame.contentWindow,
    receive: (data) => received.push(data),
  });
  using _channel = { [Symbol.dispose]: () => channel.dispose() };
  // A forged hand-over, the real one, then a second one with the same token. Each port says which
  // it is and reports anything the host sends it.
  frame.srcdoc = `<script>
    function handOver(name, token) {
      var channel = new MessageChannel();
      channel.port1.onmessage = function (e) { parent.postMessage({ portGot: name, data: e.data }, "*"); };
      parent.postMessage({ t3Plugin: 1, kind: "connect", token: token }, "*", [channel.port2]);
      channel.port1.postMessage({ from: name });
    }
    handOver("wrong-token", "other-token");
    handOver("first", ${JSON.stringify(TOKEN)});
    handOver("second", ${JSON.stringify(TOKEN)});
    parent.postMessage({ handedOver: true }, "*");
  </script>`;
  const handedOver = nextMessage((data) => (data.handedOver ? true : undefined));
  document.body.append(frame);
  // Messages from one window arrive in order, so the channel has seen every hand-over by now.
  await handedOver;

  const reply = nextMessage((data) => (typeof data.portGot === "string" ? data : undefined));
  channel.post({ probe: true });

  expect(await reply).toEqual({ portGot: "first", data: { probe: true } });
  expect(received).toEqual([{ from: "first" }]);
});

it("keeps two plugins' views apart even when one holds the other's token", async () => {
  const views = ["a", "b"] as const;
  const tokens = { a: "token-a", b: "token-b" };
  const calls: Record<string, string[]> = { a: [], b: [] };
  const frames = new Map<string, HTMLIFrameElement>();
  using stack = new DisposableStack();
  for (const id of views) {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frames.set(id, frame);
    stack.defer(() => frame.remove());
    const channel = bindPluginViewChannel({
      token: tokens[id],
      source: () => frame.contentWindow,
      receive: (data) => host.receive(data),
    });
    stack.defer(() => channel.dispose());
    const host = makePluginViewHost({
      token: tokens[id],
      post: channel.post,
      context: () => ({
        theme: "dark",
        styles: {},
        platform: "web",
        placement: "side-panel",
        view: { installationId: `inst-${id}`, viewId: "board" },
        thread: { threadId: `thread-${id}`, projectId: null },
      }),
      captureOrigin: () => null,
      invoke: async (name) => {
        calls[id]!.push(name);
        return { data: { owner: id } };
      },
      onIntents: () => undefined,
    });
  }
  const frameFor = (id: string) => frames.get(id)!;
  // Reports what the view's own bridge got back, from inside the view.
  const report = (id: string) => `<script>
    t3.ready.then(function () { return t3.invoke("mine"); }).then(function (result) {
      parent.postMessage({ view: ${JSON.stringify(id)}, data: result.data, context: t3.context }, "*");
    });</script>`;
  const reported = (id: string) =>
    nextMessage((data) =>
      data.view === id ? { data: data.data, context: data.context } : undefined,
    );

  // A goes first, so B has no port yet when A hands one over under B's token.
  frameFor("a").srcdoc = buildPluginViewDocument(
    `<script>
      var seen = [], stolen = new MessageChannel();
      stolen.port1.onmessage = function (e) { seen.push(e.data); };
      parent.postMessage({ t3Plugin: 1, kind: "connect", token: "token-b" }, "*", [stolen.port2]);
      stolen.port1.postMessage({ t3Plugin: 1, token: "token-b", kind: "ready" });
      stolen.port1.postMessage({ t3Plugin: 1, token: "token-b", kind: "invoke", id: 1, name: "steal" });
      window.addEventListener("message", function (e) {
        if (e.data && e.data.report) parent.postMessage({ stolenSaw: seen }, "*");
      });
    </script>${report("a")}`,
    tokens.a,
  );
  const reportedA = reported("a");
  document.body.append(frameFor("a"));
  expect(await reportedA).toEqual({
    data: { owner: "a" },
    context: expect.objectContaining({ thread: { threadId: "thread-a", projectId: null } }),
  });

  frameFor("b").srcdoc = buildPluginViewDocument(report("b"), tokens.b);
  const reportedB = reported("b");
  document.body.append(frameFor("b"));
  expect(await reportedB).toEqual({
    data: { owner: "b" },
    context: expect.objectContaining({ thread: { threadId: "thread-b", projectId: null } }),
  });

  const stolen = nextMessage((data) =>
    Array.isArray(data.stolenSaw) ? data.stolenSaw : undefined,
  );
  frameFor("a").contentWindow!.postMessage({ report: true }, "*");
  expect(await stolen).toEqual([]);
  expect(calls).toEqual({ a: ["mine"], b: ["mine"] });
});

it("relays the mobile view's hand-over and reports only a later load as navigation", async () => {
  const SECRET = "outer-secret";
  const relayed: unknown[] = [];
  const outer = document.createElement("iframe");
  using _outer = { [Symbol.dispose]: () => outer.remove() };
  const onRelay = (event: MessageEvent) => {
    if (event.source === outer.contentWindow && event.data?.relay) relayed.push(event.data.relay);
  };
  window.addEventListener("message", onRelay);
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", onRelay) };
  // Stands in for React Native's bridge, which the page posts every relayed message to.
  const bridge = `<script>window.ReactNativeWebView = { postMessage: function (m) {
    parent.postMessage({ relay: JSON.parse(m) }, "*");
  } };</script>`;
  outer.srcdoc = pluginViewOuterDocument(
    buildPluginViewDocument(`<script>t3.ready.then(function () {});</script>`, TOKEN),
    SECRET,
  ).replace("<head>", `<head>${bridge}`);
  // The bridge says ready over its port, so this also proves the page relays through the port.
  const ready = nextMessage((data) =>
    (data.relay as { message?: { kind?: unknown } } | undefined)?.message?.kind === "ready"
      ? true
      : undefined,
  );
  document.body.append(outer);
  await ready;
  const view = outer.contentDocument!.querySelector("iframe")!;
  expect(view.getAttribute("sandbox")).toBe("allow-scripts");

  const navigated = nextMessage((data) =>
    (data.relay as { message?: { kind?: unknown } } | undefined)?.message?.kind === "navigated"
      ? true
      : undefined,
  );
  view.srcdoc = "<p>elsewhere</p>";
  await navigated;
  expect(relayed).toEqual([
    { secret: SECRET, message: { t3Plugin: 1, kind: "connect", token: TOKEN } },
    { secret: SECRET, message: { t3Plugin: 1, kind: "ready", token: TOKEN } },
    { secret: SECRET, message: { t3Plugin: 1, kind: "navigated" } },
  ]);
});
