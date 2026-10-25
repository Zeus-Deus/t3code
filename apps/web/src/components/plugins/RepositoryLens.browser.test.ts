import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  makePluginViewHost,
  type PluginViewContext,
} from "@t3tools/client-runtime/plugins";
import type { PluginInvokeResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import viewHtml from "../../../../server/src/plugins/fixtures/consumers/repository-lens/view.html?raw";

const TOKEN = "repository-lens-token";

interface Call {
  readonly name: string;
  readonly input: unknown;
  readonly resolve: (result: PluginInvokeResult) => void;
  readonly reject: (error: Error) => void;
}

const sidePanel: PluginViewContext = {
  theme: "light",
  styles: {},
  platform: "web",
  placement: "side-panel",
  view: { installationId: "inst-1", viewId: "repository" },
  thread: { threadId: "thread-1", projectId: null },
};

const snapshot = (files: ReadonlyArray<{ path: string; x: string; y: string }>) => ({
  data: {
    repositoryPath: "/srv/repo",
    branch: "main",
    files: files.map((file) => ({
      path: file.path,
      indexStatus: file.x,
      worktreeStatus: file.y,
    })),
    commits: [{ hash: "0123456789abcdef0123456789abcdef01234567", subject: "Initial commit" }],
    truncated: false,
  },
});

/**
 * Mounts the consumer fixture behind the real bridge. The frame is left same-origin (production adds
 * `sandbox="allow-scripts"`) only so the test can read and click its DOM.
 */
function mountView(context: PluginViewContext) {
  const calls: Call[] = [];
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
    onIntents: () => undefined,
  });
  frame.srcdoc = buildPluginViewDocument(viewHtml, TOKEN);
  document.body.append(frame);
  const doc = () => frame.contentDocument!;
  const nextCall = (name: string) =>
    vi.waitFor(() => {
      const call = calls.find((entry) => entry.name === name);
      if (!call) throw new Error(`No ${name} call yet.`);
      calls.splice(calls.indexOf(call), 1);
      return call;
    });
  return {
    doc,
    nextCall,
    [Symbol.dispose]: () => {
      host.dispose();
      channel.dispose();
      frame.remove();
    },
  };
}

it("shows the diff of the newest selection when an earlier answer arrives late", async () => {
  using view = mountView(sidePanel);
  (await view.nextCall("inspect")).resolve(
    snapshot([
      { path: "src/first.ts", x: "M", y: " " },
      { path: "src/<img src=x onerror=alert(1)>.ts", x: "?", y: "?" },
    ]),
  );
  const rows = await vi.waitFor(() => {
    const found = view.doc().querySelectorAll<HTMLButtonElement>("button.file");
    expect(found).toHaveLength(2);
    return found;
  });
  // Repository-controlled names stay text.
  expect(view.doc().querySelector("img")).toBeNull();
  expect(rows[1]!.getAttribute("aria-label")).toBe(
    "Untracked: src/<img src=x onerror=alert(1)>.ts",
  );

  rows[0]!.click();
  const first = await view.nextCall("diff");
  rows[1]!.click();
  const second = await view.nextCall("diff");
  expect([first.input, second.input]).toEqual([
    { path: "src/first.ts" },
    { path: "src/<img src=x onerror=alert(1)>.ts" },
  ]);

  second.resolve({
    data: {
      path: "src/<img src=x onerror=alert(1)>.ts",
      diff: "Untracked file. Git has no tracked diff.",
      truncated: false,
    },
  });
  first.resolve({
    data: { path: "src/first.ts", diff: "@@ -1 +1 @@\n-old\n+new\n", truncated: false },
  });

  await vi.waitFor(() =>
    expect(view.doc().getElementById("diff")!.textContent).toBe(
      "Untracked file. Git has no tracked diff.",
    ),
  );
  expect(view.doc().querySelector("#diff pre")).toBeNull();
  expect(rows[1]!.getAttribute("aria-pressed")).toBe("true");
  expect(rows[0]!.getAttribute("aria-pressed")).toBe("false");
});

it("reports a failed inspection instead of showing an empty repository", async () => {
  using view = mountView(sidePanel);
  (await view.nextCall("inspect")).reject(
    new Error("Set Repository path to an absolute path in Settings > Plugins."),
  );

  await vi.waitFor(() => {
    const failure = view.doc().getElementById("failure")!;
    expect(failure.hidden).toBe(false);
    expect(failure.textContent).toContain(
      "Set Repository path to an absolute path in Settings > Plugins.",
    );
  });
  expect(view.doc().getElementById("overview")!.hidden).toBe(true);
  expect(view.doc().getElementById("branch")!.textContent).toBe("Unavailable");
  expect(view.doc().querySelector<HTMLButtonElement>("#insert")!.disabled).toBe(true);
  expect(view.doc().querySelector<HTMLButtonElement>("#refresh")!.disabled).toBe(false);
});

it.each([
  { context: sidePanel, enabled: true, hint: "Nothing is sent." },
  {
    context: { ...sidePanel, platform: "mobile", placement: "page" } as const,
    enabled: false,
    hint: "on mobile, choose Insert repository review request from the thread's menu",
  },
  {
    context: { ...sidePanel, placement: "page", thread: null } as const,
    enabled: false,
    hint: "beside a thread",
  },
])(
  "offers insertion only beside a thread off mobile ($context.platform $context.placement)",
  async ({ context, enabled, hint }) => {
    using view = mountView(context);
    (await view.nextCall("inspect")).resolve(snapshot([{ path: "a.ts", x: " ", y: "M" }]));

    await vi.waitFor(() => {
      expect(view.doc().querySelectorAll("button.file")).toHaveLength(1);
      expect(view.doc().getElementById("insert-hint")!.textContent).toContain(hint);
    });
    expect(view.doc().querySelector<HTMLButtonElement>("#insert")!.disabled).toBe(!enabled);
    // The repository setting is environment-wide, so the footer names the request's target.
    const target = view.doc().getElementById("insert-target")!;
    expect(target.hidden).toBe(false);
    expect(target.textContent).toContain("/srv/repo");
  },
);

it("names the configured repository a review request targets", async () => {
  using view = mountView(sidePanel);
  (await view.nextCall("inspect")).resolve({
    data: { ...snapshot([]).data, repositoryPath: "/home/dev/other-repo/" },
  });

  await vi.waitFor(() =>
    expect(view.doc().getElementById("insert-hint")!.textContent).toBe(
      "Adds a review request for other-repo to this thread's composer. Nothing is sent.",
    ),
  );
  expect(view.doc().getElementById("insert-target")!.title).toBe("/home/dev/other-repo/");
});
