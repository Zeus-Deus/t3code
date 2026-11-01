import {
  ProjectId,
  type PluginCapability,
  type PluginInstallation,
  type PluginManifest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPluginSettingsPatch,
  createPluginOperationId,
  describePluginCapabilities,
  environmentSupportsPlugins,
  initialPluginGrants,
  isPluginActive,
  pluginApiSupport,
  parsePluginSourceInput,
  pluginObserverError,
  pluginQuickUpdate,
  pluginReviewSubject,
  pluginActionEntries,
  pluginRunnableInstallations,
  pluginThreadStatusEntries,
  pluginSettingsDraft,
  pluginStatusPresentation,
  pluginUpdateProjects,
  pluginUpdateScopeNote,
  pluginViewEntries,
} from "./model.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

describe("environmentSupportsPlugins", () => {
  it("needs the exact API version this client renders", () => {
    expect(environmentSupportsPlugins({ repositoryIdentity: true })).toBe(false);
    expect(
      environmentSupportsPlugins({ repositoryIdentity: true, plugins: { apiVersion: 1 } }),
    ).toBe(true);
    expect(environmentSupportsPlugins(null)).toBe(false);
  });
});

describe("pluginApiSupport", () => {
  it("tells a server that is behind from a client that is behind", () => {
    expect(pluginApiSupport({ repositoryIdentity: true, plugins: { apiVersion: 1 } })).toBe(
      "supported",
    );
    expect(pluginApiSupport({ repositoryIdentity: true })).toBe("server-outdated");
    expect(pluginApiSupport(null)).toBe("server-outdated");
    expect(pluginApiSupport({ repositoryIdentity: true, plugins: { apiVersion: 0 } })).toBe(
      "server-outdated",
    );
    expect(pluginApiSupport({ repositoryIdentity: true, plugins: { apiVersion: 2 } })).toBe(
      "client-outdated",
    );
  });
});

describe("pluginActionEntries", () => {
  it("lists only actions of installations that may run code now", () => {
    const ready = pluginInstallationFixture();
    const changed = pluginInstallationFixture({
      installationId: "inst-2",
      digest: "b".repeat(64),
    });
    const disabled = pluginInstallationFixture({
      installationId: "inst-3",
      enabled: false,
      status: "disabled",
    });
    const quarantined = pluginInstallationFixture({
      installationId: "inst-4",
      status: "quarantined",
    });
    const entries = pluginActionEntries([ready, changed, disabled, quarantined], "palette");
    expect(entries.map((entry) => [entry.installation.installationId, entry.action.id])).toEqual([
      ["inst-1", "quote"],
    ]);
    expect(pluginActionEntries([ready], "thread-menu").map((entry) => entry.action.id)).toEqual([
      "menu-only",
    ]);
  });
});

describe("pluginRunnableInstallations", () => {
  it("offers nothing to run while the environment has plugin code off", () => {
    const fixture = pluginInstallationFixture();
    const installations = [
      {
        ...fixture,
        manifest: {
          ...fixture.manifest,
          actions: [
            ...fixture.manifest.actions,
            { id: "summarize", title: "Summarize", placements: ["message-selection" as const] },
          ],
          threadStatus: [{ id: "realm", title: "Realm", viewId: "board" }],
        },
      },
    ];
    expect(pluginRunnableInstallations({ installations })).toBe(installations);
    // Every entry point has something to offer when plugin code may run.
    for (const placement of ["palette", "thread-menu", "message-selection"] as const) {
      expect(pluginActionEntries(installations, placement)).not.toEqual([]);
    }
    expect(pluginViewEntries(installations)).not.toEqual([]);
    expect(pluginThreadStatusEntries(installations)).not.toEqual([]);
    const safeMode = pluginRunnableInstallations({ installations, executionDisabled: true });
    for (const placement of ["palette", "thread-menu", "message-selection"] as const) {
      expect(pluginActionEntries(safeMode, placement)).toEqual([]);
    }
    expect(pluginViewEntries(safeMode)).toEqual([]);
    expect(pluginThreadStatusEntries(safeMode)).toEqual([]);
  });
});

describe("pluginViewEntries", () => {
  it("hides views until the ui capability is granted", () => {
    const granted = pluginInstallationFixture();
    const withheld = pluginInstallationFixture({
      installationId: "inst-2",
      grants: { capabilities: ["settings"], projectIds: [] },
    });
    expect(
      pluginViewEntries([granted, withheld]).map((entry) => entry.installation.installationId),
    ).toEqual(["inst-1"]);
  });
});

describe("describePluginCapabilities", () => {
  it("names unknown requirements instead of hiding them", () => {
    const installation = pluginInstallationFixture();
    const described = describePluginCapabilities({
      ...installation.manifest,
      capabilities: ["threads.send", "filesystem.write"],
    });
    expect(described).toMatchObject([
      { capability: "threads.send", known: true, projectScoped: true },
      { capability: "filesystem.write", known: false },
    ]);
  });

  it("keeps capabilities the user denied unchecked when they review again", () => {
    const installation = pluginInstallationFixture({
      manifest: {
        ...pluginInstallationFixture().manifest,
        capabilities: ["ui", "storage", "threads.send"],
      },
      grants: { capabilities: ["ui"], projectIds: [] },
    });
    expect(initialPluginGrants(installation).capabilities).toEqual(["ui"]);
  });

  it("leaves capabilities new in an update unchecked", () => {
    const current = pluginInstallationFixture();
    const installation = pluginInstallationFixture({
      pendingUpdate: {
        manifest: {
          ...current.manifest,
          version: "2.0.0",
          capabilities: ["settings", "ui", "threads.send"],
        },
        source: current.source,
        digest: "e".repeat(64),
        generation: "gen-3",
        updatedAt: "2026-10-22T02:00:00.000Z",
      },
    });
    expect(initialPluginGrants(installation).capabilities).toEqual(["settings", "ui"]);
  });

  it("starts a review with known capabilities and previously granted projects", () => {
    const installation = pluginInstallationFixture({
      manifest: {
        ...pluginInstallationFixture().manifest,
        capabilities: ["ui", "filesystem.write"],
      },
    });
    expect(initialPluginGrants(installation)).toEqual({ capabilities: ["ui"], projectIds: [] });
  });
});

describe("pluginReviewSubject", () => {
  it("reviews a staged update while the running version stays as it is", () => {
    const current = pluginInstallationFixture();
    const installation = pluginInstallationFixture({
      pendingUpdate: {
        manifest: {
          ...current.manifest,
          version: "1.1.0",
          capabilities: ["settings", "ui", "threads.send"],
        },
        source: current.source,
        digest: "d".repeat(64),
        generation: "gen-2",
        updatedAt: "2026-10-22T01:00:00.000Z",
      },
    });
    expect(pluginReviewSubject(installation)).toMatchObject({
      kind: "update",
      digest: "d".repeat(64),
      newCapabilities: ["threads.send"],
    });
    expect(pluginStatusPresentation(installation)).toMatchObject({ label: "Ready" });
  });

  it("reviews the installed files when nothing is staged", () => {
    expect(pluginReviewSubject(pluginInstallationFixture())).toMatchObject({
      kind: "install",
      digest: "a".repeat(64),
      newCapabilities: [],
    });
  });
});

describe("pluginObserverError", () => {
  it("reports paused background events while the worker stays ready", () => {
    const paused = pluginInstallationFixture({ observerError: "Handler threw." } as never);
    expect(pluginObserverError(paused)).toBe("Handler threw.");
    expect(pluginStatusPresentation(paused)).toMatchObject({ label: "Ready", primary: "none" });
    expect(pluginObserverError(pluginInstallationFixture())).toBeNull();
  });
});

describe("pluginStatusPresentation", () => {
  it("asks for a fresh review when the installed bytes changed", () => {
    expect(
      pluginStatusPresentation(pluginInstallationFixture({ consentedDigest: "c".repeat(64) })),
    ).toMatchObject({ label: "Changed, needs review", primary: "review" });
    expect(
      pluginStatusPresentation(
        pluginInstallationFixture({ consentedDigest: null, status: "needs-consent" }),
      ),
    ).toMatchObject({ label: "Needs review", primary: "review" });
  });

  it("offers resume only for failure states", () => {
    expect(
      pluginStatusPresentation(pluginInstallationFixture({ status: "quarantined" })).primary,
    ).toBe("resume");
    expect(pluginStatusPresentation(pluginInstallationFixture()).primary).toBe("none");
  });

  it("claims nothing runs or restarts while plugin code is off, but still asks for review", () => {
    const safeMode = { executionDisabled: true };
    expect(
      pluginStatusPresentation(pluginInstallationFixture({ status: "quarantined" }), safeMode),
    ).toEqual({ label: "Paused · plugin code off", tone: "muted", primary: "none" });
    expect(
      pluginStatusPresentation(
        pluginInstallationFixture({ enabled: false, status: "disabled" }),
        safeMode,
      ).label,
    ).toBe("Disabled");
    expect(
      pluginStatusPresentation(
        pluginInstallationFixture({ consentedDigest: "c".repeat(64) }),
        safeMode,
      ).primary,
    ).toBe("review");
  });
});

describe("parsePluginSourceInput", () => {
  it("reads local folders and https Git URLs with a ref", () => {
    expect(parsePluginSourceInput(" /home/me/plugin ")).toEqual({
      ok: true,
      source: { kind: "local", directory: "/home/me/plugin" },
    });
    expect(parsePluginSourceInput("C:\\plugins\\board")).toMatchObject({ ok: true });
    expect(parsePluginSourceInput("https://github.com/acme/board.git#v1.2.0")).toEqual({
      ok: true,
      source: { kind: "git", url: "https://github.com/acme/board.git", ref: "v1.2.0" },
    });
    expect(parsePluginSourceInput("https://github.com/acme/board.git#release%2Fv1")).toEqual({
      ok: true,
      source: { kind: "git", url: "https://github.com/acme/board.git", ref: "release/v1" },
    });
    expect(parsePluginSourceInput("https://github.com/acme/board.git# ")).toEqual({
      ok: true,
      source: { kind: "git", url: "https://github.com/acme/board.git" },
    });
  });

  it("refuses a malformed percent-encoded Git ref instead of throwing", () => {
    for (const value of [
      "https://example.invalid/plugin.git#release%",
      "https://example.invalid/plugin.git#%E0%A4",
    ]) {
      expect(parsePluginSourceInput(value)).toEqual({
        ok: false,
        message: "That Git ref is not valid.",
      });
    }
  });

  it("refuses relative paths, plain http, and embedded credentials", () => {
    expect(parsePluginSourceInput("plugins/board")).toMatchObject({ ok: false });
    expect(parsePluginSourceInput("http://example.com/board.git")).toMatchObject({ ok: false });
    expect(parsePluginSourceInput("https://user:pw@example.com/board.git")).toMatchObject({
      ok: false,
    });
  });
});

describe("plugin settings", () => {
  const installation = pluginInstallationFixture({ settings: { prefix: "»", limit: 3 } });

  it("never puts a stored secret in the draft", () => {
    expect(pluginSettingsDraft(installation)).toEqual({
      prefix: "»",
      limit: "3",
      loud: false,
      token: "",
    });
  });

  it("sends only changes, keeps an untouched secret, and clears one explicitly", () => {
    const draft = { ...pluginSettingsDraft(installation), limit: "5", loud: true };
    expect(
      buildPluginSettingsPatch(installation.manifest.settings, installation.settings, draft),
    ).toEqual({
      ok: true,
      values: { limit: 5, loud: true },
    });
    expect(
      buildPluginSettingsPatch(
        installation.manifest.settings,
        installation.settings,
        pluginSettingsDraft(installation),
        new Set(["token"]),
      ),
    ).toEqual({ ok: true, values: { token: "" } });
    expect(
      buildPluginSettingsPatch(installation.manifest.settings, installation.settings, {
        ...draft,
        token: "s3cret",
      }),
    ).toMatchObject({ ok: true, values: { token: "s3cret" } });
  });

  it("does not revert a value changed elsewhere while the form was open", () => {
    const openedWith = { prefix: "»", limit: 3 };
    const draft = pluginSettingsDraft(pluginInstallationFixture({ settings: openedWith }));
    const changedElsewhere = { ...openedWith, limit: 9 };
    expect(
      buildPluginSettingsPatch(installation.manifest.settings, openedWith, {
        ...draft,
        prefix: "#",
      }),
    ).toEqual({ ok: true, values: { prefix: "#" } });
    // Diffing against the live values instead would send the stale limit back.
    expect(
      buildPluginSettingsPatch(installation.manifest.settings, changedElsewhere, {
        ...draft,
        prefix: "#",
      }),
    ).toEqual({ ok: true, values: { prefix: "#", limit: 3 } });
  });

  it("rejects numbers that do not parse", () => {
    expect(
      buildPluginSettingsPatch(installation.manifest.settings, installation.settings, {
        ...pluginSettingsDraft(installation),
        limit: "many",
      }),
    ).toEqual({ ok: false, errors: { limit: "Enter a number." } });
  });
});

it("builds operation ids the server's identifier schema accepts", () => {
  const id = createPluginOperationId(() => "1f0e-ab:cd");
  expect(id).toBe("op-1f0eabcd");
  expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
});

describe("derived compatibility", () => {
  it("stops a plugin the host no longer supports without changing what the user chose", () => {
    const unavailable = pluginInstallationFixture({
      compatibility: { available: false, missingCapabilities: ["experimental.boards"] },
    });
    expect(isPluginActive(unavailable)).toBe(false);
    expect(pluginStatusPresentation(unavailable)).toEqual({
      label: "Unavailable",
      tone: "error",
      primary: "none",
    });
    expect(
      pluginStatusPresentation({ ...unavailable, enabled: false, status: "disabled" }).label,
    ).toBe("Disabled · unavailable here");
    // A host that learned the capability lifts a persisted `incompatible` from an older write.
    expect(
      isPluginActive(
        pluginInstallationFixture({ compatibility: { available: true, missingCapabilities: [] } }),
      ),
    ).toBe(true);
  });

  it("treats an unknown optional capability as degrading, not blocking", () => {
    const manifest = {
      ...pluginInstallationFixture().manifest,
      capabilities: ["settings"],
      optionalCapabilities: ["ui", "experimental.boards"],
    };
    expect(
      describePluginCapabilities(manifest).map(({ capability, known, optional }) => ({
        capability,
        known,
        optional,
      })),
    ).toEqual([
      { capability: "settings", known: true, optional: false },
      { capability: "ui", known: true, optional: true },
      { capability: "experimental.boards", known: false, optional: true },
    ]);
    expect(
      initialPluginGrants(pluginInstallationFixture({ consentedDigest: null, manifest }))
        .capabilities,
    ).toEqual(["settings", "ui"]);
  });
});

describe("pluginQuickUpdate", () => {
  const stage = (
    overrides: Parameters<typeof pluginInstallationFixture>[0],
    capabilities: ReadonlyArray<PluginCapability>,
    optionalCapabilities: ReadonlyArray<string> = [],
    kind?: "local-repair" | "previous",
  ) => {
    const running = pluginInstallationFixture(overrides);
    return {
      ...running,
      pendingUpdate: {
        ...(kind ? { kind } : {}),
        manifest: { ...manifest, capabilities, optionalCapabilities },
        source: running.source,
        digest: "d".repeat(64),
        generation: "gen-2",
        updatedAt: "2026-10-23T00:00:00.000Z",
      },
    };
  };
  const capabilityIds = (entries: ReadonlyArray<{ readonly capability: string }>) =>
    entries.map((entry) => entry.capability);
  const manifest: PluginManifest = {
    ...pluginInstallationFixture().manifest,
    capabilities: ["ui"],
  };
  const projectId = ProjectId.make("proj-1");
  const running = {
    manifest,
    grants: { capabilities: ["ui"], projectIds: [projectId] },
  } satisfies Partial<PluginInstallation>;

  it("carries grants and projects over when nothing new is requested", () => {
    const update = pluginQuickUpdate(stage(running, ["ui"]));
    expect(update?.grants).toEqual({ capabilities: ["ui"], projectIds: [projectId] });
    expect(update?.added).toEqual([]);
    expect(update?.offered).toEqual([]);
  });

  it("grants new required permissions and names each one", () => {
    const update = pluginQuickUpdate(stage(running, ["ui", "threads.send"]));
    expect(update?.grants).toEqual({
      capabilities: ["ui", "threads.send"],
      projectIds: [projectId],
    });
    expect(capabilityIds(update?.added ?? [])).toEqual(["threads.send"]);
  });

  it("names a required permission the user turned off rather than restoring it silently", () => {
    const update = pluginQuickUpdate(
      stage(
        {
          grants: { capabilities: ["ui"], projectIds: [] },
          manifest: { ...manifest, capabilities: ["ui", "storage"] },
        },
        ["ui", "storage"],
      ),
    );
    expect(capabilityIds(update?.added ?? [])).toEqual(["storage"]);
    expect(update?.grants.capabilities).toEqual(["ui", "storage"]);
  });

  it("leaves new optional permissions off and does not re-ask declined ones", () => {
    const update = pluginQuickUpdate(
      stage(
        {
          ...running,
          manifest: { ...manifest, optionalCapabilities: ["storage"] },
        },
        ["ui"],
        ["storage", "ui.changes"],
      ),
    );
    expect(capabilityIds(update?.offered ?? [])).toEqual(["ui.changes"]);
    expect(update?.added).toEqual([]);
    expect(update?.grants.capabilities).toEqual(["ui"]);
  });

  it("drops permissions the new version no longer requests", () => {
    const update = pluginQuickUpdate(
      stage({ grants: { capabilities: ["ui", "storage"], projectIds: [] } }, ["ui"]),
    );
    expect(update?.grants.capabilities).toEqual(["ui"]);
  });

  it("leaves everything else to the full review", () => {
    expect(pluginQuickUpdate(pluginInstallationFixture())).toBeNull();
    expect(pluginQuickUpdate(stage({ ...running, consentedDigest: null }, ["ui"]))).toBeNull();
    expect(pluginQuickUpdate(stage(running, ["ui"], [], "local-repair"))).toBeNull();
    expect(pluginQuickUpdate(stage(running, ["ui"], [], "previous"))).toBeNull();
    expect(
      pluginQuickUpdate(stage(running, ["ui", "future.required" as PluginCapability])),
    ).toBeNull();
  });
});

describe("pluginUpdateScopeNote", () => {
  it("never reads as fewer projects than the update carries over", () => {
    const note = (ids: ReadonlyArray<string>, titles: ReadonlyArray<string>) =>
      pluginUpdateScopeNote(pluginUpdateProjects(ids, titles));

    expect(note(["a", "b"], ["Alpha", "Beta"])).toBe("In Alpha, Beta");
    // The project list has not loaded, or one project is gone.
    expect(note(["a", "b"], [])).toBe("In 2 projects");
    expect(note(["a"], [])).toBe("In 1 project");
    expect(note(["a", "b"], ["Alpha"])).toBe("In 2 projects");
    expect(note([], [])).toContain("No projects chosen yet");
  });
});

describe("pluginReviewSubject for recovery revisions", () => {
  it("lists capability and setting changes a local fix brings", () => {
    const running = pluginInstallationFixture();
    const subject = pluginReviewSubject({
      ...running,
      pendingUpdate: {
        kind: "local-repair",
        manifest: {
          ...running.manifest,
          capabilities: ["settings", "threads.send"],
          settings: [
            { key: "prefix", label: "Prefix", type: "string" },
            { key: "limit", label: "Limit", type: "string" },
            { key: "channel", label: "Channel", type: "string" },
          ],
        },
        source: { kind: "local", directory: "/home/u/.t3/plugins/workspaces/inst-1/1" },
        digest: "d".repeat(64),
        generation: "gen-2",
        updatedAt: "2026-10-23T00:00:00.000Z",
      },
    });
    expect(subject).toMatchObject({
      revision: "local-repair",
      newCapabilities: ["threads.send"],
      removedCapabilities: ["ui"],
      settingChanges: [
        { key: "limit", label: "Limit", change: "type-changed" },
        { key: "channel", label: "Channel", change: "added" },
        { key: "loud", label: "Loud", change: "removed" },
        { key: "token", label: "Token", change: "removed" },
      ],
    });
  });

  it("calls a staged update from an older server a publisher update", () => {
    const running = pluginInstallationFixture();
    expect(
      pluginReviewSubject({
        ...running,
        pendingUpdate: {
          manifest: running.manifest,
          source: running.source,
          digest: "e".repeat(64),
          generation: "gen-2",
          updatedAt: "2026-10-23T00:00:00.000Z",
        },
      }).revision,
    ).toBe("update");
  });
});
