import { ThreadId, type PluginInvokeResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPluginViewDocument,
  makePluginViewHost,
  MAX_PLUGIN_CARD_HEIGHT,
  PLUGIN_VIEW_CONTENT_SECURITY_POLICY,
  type PluginViewBridgeFeature,
  type PluginViewContext,
} from "./viewHost.ts";
import { acceptPluginViewPort } from "./viewChannel.ts";

const context: PluginViewContext = {
  theme: "dark",
  styles: { "--color-background-primary": "#000" },
  platform: "web",
  placement: "page",
  view: { installationId: "inst-1", viewId: "board" },
  thread: null,
};

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TOKEN = "doc-token-1";

function setup(
  invoke: (name: string, input: unknown) => Promise<PluginInvokeResult>,
  features: ReadonlyArray<PluginViewBridgeFeature> = [],
) {
  const posted: unknown[] = [];
  const heights: number[] = [];
  const intents: unknown[] = [];
  const origins: unknown[] = [];
  const unsupported: number[] = [];
  let location = "/plugins/board";
  const host = makePluginViewHost({
    token: TOKEN,
    post: (message) => posted.push(message),
    context: () => context,
    captureOrigin: () => ({ location }),
    invoke,
    onIntents: (next, origin, skipped) => {
      intents.push(...next);
      origins.push(origin);
      unsupported.push(skipped);
    },
    features,
    onResize: (height) => heights.push(height),
  });
  return {
    host,
    posted,
    heights,
    intents,
    origins,
    unsupported,
    moveTo: (next: string) => {
      location = next;
    },
  };
}

describe("makePluginViewHost", () => {
  it("answers a ready frame with its context", () => {
    const { host, posted } = setup(() => Promise.resolve({}));
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "ready" });
    expect(posted).toEqual([{ t3Plugin: 1, kind: "context", context }]);
  });

  it("returns data to the frame and hands intents to the client", async () => {
    const call = deferred<PluginInvokeResult>();
    const names: string[] = [];
    const { host, posted, intents } = setup((name) => {
      names.push(name);
      return call.promise;
    });
    host.receive({
      t3Plugin: 1,
      token: TOKEN,
      kind: "invoke",
      id: 7,
      name: "list",
      input: { page: 1 },
    });
    call.resolve({
      data: { items: [] },
      intents: [{ type: "view.open", viewId: "board" }],
    });
    await call.promise;
    await Promise.resolve();
    expect(names).toEqual(["list"]);
    expect(intents).toEqual([{ type: "view.open", viewId: "board" }]);
    // Intents stay with the host; the frame only sees message and data.
    expect(posted).toEqual([
      { t3Plugin: 1, kind: "result", id: 7, ok: true, value: { data: { items: [] } } },
    ]);
  });

  it("applies intents to where the user was when the view asked, not where they are now", async () => {
    const call = deferred<PluginInvokeResult>();
    const { host, origins, moveTo } = setup(() => call.promise);
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id: 1, name: "review" });
    moveTo("/env/other-thread");
    call.resolve({ intents: [{ type: "thread.reveal", threadId: ThreadId.make("thread-a") }] });
    await call.promise;
    await Promise.resolve();
    expect(origins).toEqual([{ location: "/plugins/board" }]);
  });

  it("tells the client about intents only a newer app understands, even with none it can apply", async () => {
    const newer = deferred<PluginInvokeResult>();
    const older = deferred<PluginInvokeResult>();
    const answers = [newer.promise, older.promise];
    const { host, posted, intents, origins, unsupported } = setup(() => answers.shift()!);
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id: 1, name: "plan" });
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id: 2, name: "plan" });
    // What this client's contracts leave of a result whose only intents are from a newer API.
    newer.resolve({ data: { ok: true }, intents: [], unsupportedIntentCount: 2 });
    // An older server sends no count and no intents: nothing to tell the user.
    older.resolve({ message: "done" });
    await Promise.all([newer.promise, older.promise]);
    await Promise.resolve();
    expect(intents).toEqual([]);
    expect(origins).toEqual([{ location: "/plugins/board" }]);
    expect(unsupported).toEqual([2]);
    expect(posted).toEqual([
      { t3Plugin: 1, kind: "result", id: 1, ok: true, value: { data: { ok: true } } },
      { t3Plugin: 1, kind: "result", id: 2, ok: true, value: { message: "done" } },
    ]);
  });

  it("ignores messages from a document that does not hold this document's token", () => {
    const calls: string[] = [];
    const { host, posted } = setup((name) => {
      calls.push(name);
      return Promise.resolve({});
    });
    // A page the frame navigated to shares the WindowProxy but never saw the token.
    host.receive({ t3Plugin: 1, kind: "ready" });
    host.receive({ t3Plugin: 1, token: "guess", kind: "invoke", id: 1, name: "followup" });
    host.receive({ t3Plugin: 1, kind: "invoke", id: 2, name: "followup" });
    expect(calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("refuses handler names that could address another handler kind", () => {
    const { host, posted } = setup(() => Promise.resolve({}));
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id: 1, name: "action:quote" });
    host.receive({
      t3Plugin: 1,
      token: TOKEN,
      kind: "invoke",
      id: 2,
      name: "../event:run.finalized",
    });
    expect(posted).toMatchObject([
      { id: 1, ok: false, error: { reason: "invalid_handler" } },
      { id: 2, ok: false, error: { reason: "invalid_handler" } },
    ]);
  });

  it("bounds requests in flight", () => {
    const { host, posted } = setup(() => new Promise<PluginInvokeResult>(() => undefined));
    for (let id = 1; id <= 9; id += 1) {
      host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id, name: "list" });
    }
    expect(posted).toEqual([
      {
        t3Plugin: 1,
        kind: "result",
        id: 9,
        ok: false,
        error: { reason: "busy", message: "Too many requests in flight." },
      },
    ]);
  });

  it("drops results that arrive after the view went away", async () => {
    const call = deferred<PluginInvokeResult>();
    const { host, posted, intents } = setup(() => call.promise);
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id: 1, name: "review" });
    host.dispose();
    call.resolve({ intents: [{ type: "view.open", viewId: "board" }] });
    await call.promise;
    await Promise.resolve();
    expect(posted).toEqual([]);
    expect(intents).toEqual([]);
  });

  it("reports server failures without leaking anything but reason and message", async () => {
    const call = deferred<PluginInvokeResult>();
    const { host, posted } = setup(() => call.promise);
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "invoke", id: 3, name: "add" });
    call.reject({ reason: "permission_denied", message: "Not granted.", stack: "secret" });
    await call.promise.catch(() => undefined);
    await Promise.resolve();
    expect(posted).toEqual([
      {
        t3Plugin: 1,
        kind: "result",
        id: 3,
        ok: false,
        error: { reason: "permission_denied", message: "Not granted." },
      },
    ]);
  });
});

describe("bridge features", () => {
  it("offers changes, local intents and resizing only to documents built with them", () => {
    const old = setup(() => Promise.resolve({}));
    old.host.changed("view:board");
    old.host.receive({ t3Plugin: 1, token: TOKEN, kind: "resize", height: 300 });
    old.host.receive({
      t3Plugin: 1,
      token: TOKEN,
      kind: "intent",
      id: 1,
      intent: { type: "view.open", viewId: "board" },
    });
    expect(old.heights).toEqual([]);
    expect(old.intents).toEqual([]);
    expect(old.posted).toMatchObject([{ id: 1, ok: false, error: { reason: "unsupported" } }]);

    const card = setup(() => Promise.resolve({}), ["changes", "local-intents", "resize"]);
    card.host.changed("view:board");
    card.host.receive({ t3Plugin: 1, token: TOKEN, kind: "resize", height: 120.2 });
    card.host.receive({ t3Plugin: 1, token: TOKEN, kind: "resize", height: 1e9 });
    card.host.receive({ t3Plugin: 1, token: TOKEN, kind: "resize", height: Number.NaN });
    expect(card.heights).toEqual([121, MAX_PLUGIN_CARD_HEIGHT]);
    expect(card.posted).toEqual([{ t3Plugin: 1, kind: "changed", topic: "view:board" }]);
  });

  it("applies a valid local intent where the user is, and refuses what this app cannot do", () => {
    const { host, posted, intents, origins, moveTo } = setup(
      () => Promise.resolve({}),
      ["local-intents"],
    );
    moveTo("/env/thread-b");
    const reveal = { type: "thread.reveal", threadId: "thread-a" };
    host.receive({ t3Plugin: 1, token: TOKEN, kind: "intent", id: 4, intent: reveal });
    host.receive({
      t3Plugin: 1,
      token: TOKEN,
      kind: "intent",
      id: 5,
      intent: { type: "workspace.format-disk" },
    });
    expect(intents).toEqual([reveal]);
    expect(origins).toEqual([{ location: "/env/thread-b" }]);
    expect(posted).toMatchObject([
      { id: 4, ok: true, value: {} },
      { id: 5, ok: false, error: { reason: "unsupported" } },
    ]);
  });

  it("stops delivering changes once the view is gone", () => {
    const { host, posted } = setup(() => Promise.resolve({}), ["changes"]);
    host.dispose();
    host.changed("view:board");
    expect(posted).toEqual([]);
  });
});

describe("buildPluginViewDocument", () => {
  const preamble = (document: string) =>
    document.startsWith(
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"',
    );

  it.each([
    [
      "a full document",
      "<!doctype html><html><head><script>evil()</script></head><body></body></html>",
    ],
    ["text before head", "x<head><script>evil()</script></head>"],
    ["an element before head", '<img src="https://track.example/p.gif"><head></head>'],
    ["a head inside a comment", "<!-- <head> --><script>evil()</script>"],
    ["a head inside a title", "<title><head></title><script>evil()</script>"],
    ["no head at all", "<p>hi</p>"],
  ])("puts the policy and bridge first for %s", (_name, html) => {
    const document = buildPluginViewDocument(html, TOKEN);
    expect(preamble(document)).toBe(true);
    expect(document.indexOf(PLUGIN_VIEW_CONTENT_SECURITY_POLICY)).toBeLessThan(
      document.indexOf("</head>"),
    );
  });

  it("drops the author's doctype so the document keeps one", () => {
    const document = buildPluginViewDocument("  <!DOCTYPE html><p>hi</p>", TOKEN);
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
    expect(document.endsWith("</head><p>hi</p>")).toBe(true);
  });

  it("gives the bridge this document's token", () => {
    expect(buildPluginViewDocument("<p>hi</p>", TOKEN)).toContain(JSON.stringify(TOKEN));
  });
});

describe("acceptPluginViewPort", () => {
  it("takes the port only from a hand-over with this document's token", () => {
    const { port1, port2 } = new MessageChannel();
    const connect = { t3Plugin: 1, kind: "connect", token: TOKEN };
    expect(acceptPluginViewPort(connect, [port2], TOKEN)).toBe(port2);
    expect(acceptPluginViewPort({ ...connect, token: "guess" }, [port2], TOKEN)).toBeNull();
    expect(acceptPluginViewPort(connect, [], TOKEN)).toBeNull();
    expect(acceptPluginViewPort({ ...connect, kind: "ready" }, [port2], TOKEN)).toBeNull();
    port1.close();
    port2.close();
  });
});
