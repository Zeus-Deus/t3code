import type { PluginCardReference, PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePluginCardPresentation } from "./cards.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const card: PluginCardReference = {
  installationId: "inst-launcher",
  generation: "gen-old",
  dataOwner: "owner-1",
  viewId: "task",
  summary: "Launch plan: fix login (Codex, worktree)",
  data: { planId: "plan-1" },
};

const launcher = (overrides: Partial<PluginInstallation> = {}): PluginInstallation => {
  const base = pluginInstallationFixture();
  return {
    ...base,
    installationId: "inst-launcher",
    generation: "gen-new",
    manifest: {
      ...base.manifest,
      name: "Task launcher",
      capabilities: ["ui", "ui.conversation-cards"],
      views: [{ id: "task", title: "Task", entry: "view.html", placement: "conversation" }],
    },
    grants: { capabilities: ["ui", "ui.conversation-cards"], projectIds: [] },
    ...overrides,
  };
};

const present = (
  installations: ReadonlyArray<PluginInstallation> | null,
  options: { supported?: boolean; executionDisabled?: boolean } = {},
) =>
  resolvePluginCardPresentation({
    card,
    supported: options.supported ?? true,
    installations,
    executionDisabled: options.executionDisabled ?? false,
  });

describe("resolvePluginCardPresentation", () => {
  it("mounts a card from an earlier generation of the same installation", () => {
    expect(present([launcher()])).toMatchObject({ kind: "live", view: { id: "task" } });
  });

  it("keeps the recorded summary readable whenever the view cannot be served", () => {
    const cases: Array<[ReturnType<typeof present>, string | null]> = [
      [present(null), null],
      [present([launcher()], { supported: false }), "cannot show plugin cards"],
      [present([]), "not installed here"],
      [present([launcher()], { executionDisabled: true }), "turned off"],
      [present([launcher({ enabled: false, status: "disabled" })]), ""],
      [
        present([launcher({ grants: { capabilities: ["ui"], projectIds: [] } })]),
        "not allowed to show cards",
      ],
      [
        present([
          launcher({
            manifest: { ...launcher().manifest, views: [] },
          }),
        ]),
        "no longer shows this card",
      ],
      [
        present([
          launcher({
            manifest: {
              ...launcher().manifest,
              views: [{ id: "task", title: "Task", entry: "view.html", placement: "page" }],
            },
          }),
        ]),
        "no longer shows this card",
      ],
    ];
    for (const [presentation, reason] of cases) {
      expect(presentation.kind).toBe("summary");
      if (presentation.kind !== "summary") continue;
      if (reason === null) expect(presentation.reason).toBeNull();
      else expect(presentation.reason).toContain(reason);
    }
  });

  it("never matches another installation that happens to share the plugin id", () => {
    const other = launcher({ installationId: "inst-other" });
    expect(present([other])).toMatchObject({ kind: "summary", pluginName: null });
  });

  it("says plugin code is off in safe mode rather than that the plugin is gone", () => {
    // Safe mode hides runnable installations; the full catalogue still names the plugin.
    for (const installations of [[], [launcher()]]) {
      expect(present(installations, { executionDisabled: true })).toMatchObject({
        kind: "summary",
        reason: "Plugin code is turned off on this environment.",
      });
    }
    expect(present([launcher()], { executionDisabled: true })).toMatchObject({
      pluginName: "Task launcher",
    });
  });
});
