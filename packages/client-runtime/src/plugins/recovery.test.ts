import { PluginError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pluginApprovalBacklogStep,
  pluginAttention,
  pluginAttentionCount,
  pluginAttentionNotice,
  pluginBacklogDecision,
  pluginCurrentRevisionNote,
  pluginFailureNeedsDetails,
  pluginInactiveReason,
  pluginRecoveryActions,
  pluginRecoveryDetails,
  pluginRemovalNote,
} from "./recovery.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const fault = {
  hostVersion: "2.2.0",
  nodeVersion: "24.1.0",
  at: "2026-10-23T10:00:00.000Z",
  reason: "start_failed",
  message: "Cannot find module 'node:sqlite'",
  handler: "action:quote",
};

describe("pluginAttention", () => {
  it("falls back to the persisted status when the server derives no attention", () => {
    expect(pluginAttention(pluginInstallationFixture())).toBeNull();
    expect(
      pluginAttention(pluginInstallationFixture({ status: "quarantined", error: null })),
    ).toMatchObject({ kind: "fault", message: "Stopped after repeated failures." });
    expect(
      pluginAttention(
        pluginInstallationFixture({
          status: "incompatible",
          error: "Needs boards",
          enabled: false,
        }),
      ),
    ).toMatchObject({ kind: "unavailable", message: "Needs boards", notify: false });
    expect(
      pluginAttention(pluginInstallationFixture({ observerError: "Thread not found" })),
    ).toMatchObject({ kind: "events-paused", message: "Thread not found" });
  });

  it("prefers the server's attention and keeps unknown kinds visible", () => {
    const reported = pluginAttention(
      pluginInstallationFixture({
        status: "error",
        error: "stale",
        attention: { kind: "lifecycle-blocked", message: "Waiting on host", since: fault.at },
      }),
    );
    expect(reported).toMatchObject({
      kind: "other",
      title: "Needs attention",
      message: "Waiting on host",
    });
  });

  it("gives a new failure a new key so an old dismissal does not hide it", () => {
    const at = (since: string) =>
      pluginAttention(
        pluginInstallationFixture({ attention: { kind: "fault", message: "boom", since } }),
      )?.key;
    expect(at("2026-10-23T10:00:00.000Z")).not.toBe(at("2026-10-23T11:00:00.000Z"));
  });

  it("does not nag about a plugin the user turned off unless it is a real failure", () => {
    const disabled = (kind: string) =>
      pluginAttention(
        pluginInstallationFixture({
          enabled: false,
          status: "disabled",
          attention: { kind, message: "m", since: fault.at },
        }),
      )?.notify;
    expect(disabled("unavailable")).toBe(false);
    expect(disabled("read-only")).toBe(true);
    expect(disabled("fault")).toBe(true);
  });

  it("says nothing about paused events for a plugin the user turned off", () => {
    // The missed-runs choice is asked when it is turned back on; there is nothing to act on here.
    const paused = (enabled: boolean) =>
      pluginAttention(
        pluginInstallationFixture({
          enabled,
          status: enabled ? "idle" : "disabled",
          attention: {
            kind: "events-paused",
            message: "Choose whether to skip or deliver pending events before resuming.",
            since: fault.at,
          },
        }),
      );
    expect(paused(false)).toBeNull();
    expect(paused(true)).toMatchObject({ kind: "events-paused", notify: true });
  });

  it("leaves safe mode to the environment instead of flagging every plugin", () => {
    const safeMode = (overrides: Parameters<typeof pluginInstallationFixture>[0]) =>
      pluginInstallationFixture({
        ...overrides,
        attention: {
          kind: "safe-mode",
          message: "Plugin execution is disabled in safe mode.",
          since: fault.at,
        },
      });
    const enabled = safeMode({ installationId: "on" });
    const disabled = safeMode({ installationId: "off", enabled: false, status: "disabled" });
    expect(pluginAttention(enabled)).toBeNull();
    expect(pluginAttention(disabled)).toBeNull();
    expect(pluginAttentionNotice({ installations: [enabled, disabled] })).toBeNull();
    // What the record itself says still shows: a failure from before the restart is real.
    expect(
      pluginAttention(safeMode({ status: "quarantined", error: "Crashed on start" })),
    ).toMatchObject({ kind: "fault", message: "Crashed on start", notify: true });
  });
});

describe("pluginAttentionNotice", () => {
  const broken = pluginInstallationFixture({
    installationId: "inst-b",
    manifest: { ...pluginInstallationFixture().manifest, name: "Board" },
    attention: { kind: "fault", message: "boom", since: fault.at },
  });
  const paused = pluginInstallationFixture({
    installationId: "inst-a",
    attention: { kind: "events-paused", message: "paused", since: fault.at },
  });

  it("groups every affected plugin of an environment into one notice", () => {
    expect(pluginAttentionNotice({ installations: [pluginInstallationFixture()] })).toBeNull();
    const notice = pluginAttentionNotice({
      installations: [broken, paused, pluginInstallationFixture({ installationId: "ok" })],
      environmentLabel: "Laptop",
    });
    expect(notice).toMatchObject({
      tone: "error",
      title: "2 plugins need attention on Laptop",
      description: "Board: Stopped after a failure. Quote helper: Background events paused.",
    });
    expect(notice?.key).toBe(
      pluginAttentionNotice({ installations: [paused, broken], environmentLabel: "Laptop" })?.key,
    );
  });

  it("names a single plugin and warns, not errors, when only events are paused", () => {
    expect(pluginAttentionNotice({ installations: [paused] })).toMatchObject({
      tone: "warning",
      title: "Quote helper needs attention",
    });
  });

  it("reports a catalogue that could not be loaded for the whole environment", () => {
    expect(
      pluginAttentionNotice({
        installations: [],
        loadError: "Request timed out",
        environmentLabel: "Laptop",
      }),
    ).toMatchObject({
      tone: "error",
      title: "Could not load plugins on Laptop",
      description: "Request timed out",
      entries: [],
    });
  });

  it("counts each affected plugin, or an environment-wide problem once, for a badge", () => {
    expect(pluginAttentionCount(pluginAttentionNotice({ installations: [broken, paused] }))).toBe(
      2,
    );
    expect(
      pluginAttentionCount(pluginAttentionNotice({ installations: [], loadError: "timed out" })),
    ).toBe(1);
    expect(
      pluginAttentionCount(pluginAttentionNotice({ installations: [pluginInstallationFixture()] })),
    ).toBe(0);
  });

  it("reports plugin data that could not be opened for the whole environment", () => {
    expect(
      pluginAttentionNotice({ installations: [], unavailableMessage: "Database is locked" }),
    ).toMatchObject({
      tone: "error",
      title: "Plugins unavailable",
      description: "Database is locked",
    });
  });
});

describe("pluginRecoveryDetails", () => {
  it("shows versions at the failure and at the last normal run side by side", () => {
    const rows = pluginRecoveryDetails(
      pluginInstallationFixture({
        health: {
          fault,
          lastHealthy: {
            hostVersion: "2.1.0",
            nodeVersion: "22.9.0",
            at: "2026-10-20T00:00:00.000Z",
          },
        },
        attention: { kind: "fault", message: fault.message, since: fault.at },
        recovery: {
          activeSource: "local-repair",
          upstreamSource: { kind: "git", url: "https://example.com/p.git", ref: "v1" },
          previous: {
            version: "0.9.0",
            digest: "c".repeat(64),
            source: { kind: "local", directory: "/p" },
          },
          repair: {
            workspaceId: "ws-1",
            directory: "/home/u/.t3/plugins/workspaces/inst-1/1",
            baseDigest: "a".repeat(64),
            baseGeneration: "gen-1",
            draft: "Fix it",
          },
        },
      }),
      (iso) => iso.slice(0, 10),
    );
    expect(rows).toEqual([
      { label: "Stopped after a failure", value: fault.message },
      { label: "Failed in", value: "action:quote", code: true },
      { label: "When it failed", value: "2026-10-23 · T3 Code 2.2.0 · Node 24.1.0" },
      { label: "Last ran normally", value: "2026-10-20 · T3 Code 2.1.0 · Node 22.9.0" },
      { label: "Active revision", value: "Your local fix, v1.0.0" },
      { label: "Publisher source", value: "https://example.com/p.git#v1", code: true },
      { label: "Previous version kept", value: "v0.9.0" },
      {
        label: "Repair folder",
        value: "/home/u/.t3/plugins/workspaces/inst-1/1",
        code: true,
      },
    ]);
  });

  it("keeps an earlier failure as history once the active revision ran normally", () => {
    const rows = pluginRecoveryDetails(
      pluginInstallationFixture({
        health: {
          fault,
          lastHealthy: { hostVersion: "2.2.0", nodeVersion: "24.1.0", at: "2026-10-23T11:00:00Z" },
        },
        recovery: { activeSource: "local-repair" },
      }),
      (iso) => iso.slice(0, 13),
    );
    expect(rows).toEqual([
      { label: "Last recorded failure", value: fault.message },
      { label: "Failed in", value: "action:quote", code: true },
      { label: "When it failed", value: "2026-10-23T10 · T3 Code 2.2.0 · Node 24.1.0" },
      { label: "Ran normally after that", value: "2026-10-23T11 · T3 Code 2.2.0 · Node 24.1.0" },
      { label: "Active revision", value: "Your local fix, v1.0.0" },
    ]);
  });

  it("shows none of a read-only record's placeholder capabilities, source or fingerprint", () => {
    const readOnly = pluginInstallationFixture({
      recordIssue: "corrupt",
      manifest: { ...pluginInstallationFixture().manifest, capabilities: ["unsupported-record"] },
      compatibility: { available: false, missingCapabilities: ["unsupported-record"] },
      source: { kind: "local", directory: "" },
      digest: "0".repeat(64),
    });
    expect(pluginRecoveryDetails(readOnly, (iso) => iso)).toEqual([]);
  });
});

describe("pluginCurrentRevisionNote", () => {
  it("claims the installed revision keeps running only while it can run", () => {
    expect(pluginCurrentRevisionNote(pluginInstallationFixture())).toBe(
      "Version 1.0.0 keeps running until you approve.",
    );
    for (const stopped of [
      pluginInstallationFixture({ enabled: false, status: "disabled" }),
      pluginInstallationFixture({ status: "quarantined" }),
      pluginInstallationFixture({ compatibility: { available: false, missingCapabilities: [] } }),
    ]) {
      expect(pluginCurrentRevisionNote(stopped)).toBe(
        "Version 1.0.0 stays selected until you approve.",
      );
    }
    expect(
      pluginCurrentRevisionNote(
        pluginInstallationFixture({
          enabled: false,
          status: "disabled",
          recovery: { activeSource: "local-repair" },
        }),
      ),
    ).toBe("Your local fix stays selected until you approve.");
  });
});

describe("pluginInactiveReason", () => {
  it("says why a plugin is not running instead of a blanket disabled-or-review", () => {
    expect(pluginInactiveReason(pluginInstallationFixture())).toBeNull();
    expect(
      pluginInactiveReason(
        pluginInstallationFixture({
          compatibility: { available: false, missingCapabilities: ["threads.fork"] },
          attention: {
            kind: "unavailable",
            message: "Needs threads.fork, which this environment does not support.",
            since: "2026-10-23T10:00:00.000Z",
          },
        }),
      ),
    ).toBe(
      "Unavailable on this environment: Needs threads.fork, which this environment does not support.",
    );
    expect(
      pluginInactiveReason(
        pluginInstallationFixture({
          status: "quarantined",
          attention: { kind: "fault", message: fault.message, since: fault.at },
        }),
      ),
    ).toBe(`Stopped after a failure: ${fault.message}`);
    expect(
      pluginInactiveReason(pluginInstallationFixture({ consentedDigest: "b".repeat(64) })),
    ).toBe("The plugin's files changed. Review them before it can run.");
    expect(
      pluginInactiveReason(pluginInstallationFixture({ enabled: false, status: "disabled" })),
    ).toBe("The plugin is turned off.");
    expect(pluginInactiveReason(pluginInstallationFixture({ recordIssue: "newer" }))).toContain(
      "Update T3 Code",
    );
  });
});

describe("pluginRecoveryActions", () => {
  const previous = {
    version: "0.9.0",
    digest: "c".repeat(64),
    source: { kind: "local", directory: "/p" },
  } as const;

  it("offers nothing a server without recovery support could answer", () => {
    expect(pluginRecoveryActions(pluginInstallationFixture(), false)).toMatchObject({
      repair: null,
      usePrevious: null,
    });
  });

  it("offers no management for a read-only record and never advises reinstalling", () => {
    const readOnly = pluginInstallationFixture({
      recordIssue: "newer",
      recovery: { activeSource: "upstream", previous },
    });
    expect(pluginRecoveryActions(readOnly, true)).toMatchObject({
      repair: null,
      usePrevious: null,
    });
    const attention = pluginAttention(readOnly);
    expect(attention).toMatchObject({ kind: "read-only", notify: true });
    expect(attention?.message).toContain("Update T3 Code");
    expect(attention?.message).not.toMatch(/reinstall|remove/i);
  });

  it("reopens an existing repair folder and does not restage what is already staged", () => {
    const actions = pluginRecoveryActions(
      pluginInstallationFixture({
        recovery: {
          activeSource: "upstream",
          previous,
          repair: {
            workspaceId: "ws-1",
            directory: "/w",
            baseDigest: "a".repeat(64),
            baseGeneration: "gen-1",
            draft: "d",
          },
        },
        pendingUpdate: {
          kind: "previous",
          manifest: pluginInstallationFixture().manifest,
          source: previous.source,
          digest: previous.digest,
          generation: "gen-2",
          updatedAt: fault.at,
        },
      }),
      true,
    );
    expect(actions).toEqual({
      repair: "open",
      stageRepair: true,
      usePrevious: null,
      runningLocalFix: false,
    });
  });
});

describe("pluginRecoveryActions after the running files changed", () => {
  it("prepares a fresh repair copy instead of reopening a folder made from other files", () => {
    const actions = pluginRecoveryActions(
      pluginInstallationFixture({
        recovery: {
          activeSource: "upstream",
          repair: {
            workspaceId: "ws-1",
            directory: "/w",
            baseDigest: "d".repeat(64),
            baseGeneration: "gen-0",
            draft: "d",
          },
        },
      }),
      true,
    );
    // The server only stages a folder made from the running files.
    expect(actions).toMatchObject({ repair: "prepare", stageRepair: false });
  });

  const localFix = (directory: string) =>
    pluginInstallationFixture({
      digest: "e".repeat(64),
      consentedDigest: "e".repeat(64),
      source: { kind: "local", directory },
      recovery: {
        activeSource: "local-repair",
        repair: {
          workspaceId: "ws-1",
          directory: "/t3/plugins/workspaces/inst-1/1",
          baseDigest: "a".repeat(64),
          baseGeneration: "gen-1",
          draft: "d",
        },
      },
    });

  it("keeps one repair folder across repeated local fixes staged from it", () => {
    expect(pluginRecoveryActions(localFix("/t3/plugins/workspaces/inst-1/1/"), true)).toMatchObject(
      { repair: "open", stageRepair: true, runningLocalFix: true },
    );
  });

  it("prepares a fresh copy when the running local fix came from another folder", () => {
    expect(pluginRecoveryActions(localFix("/elsewhere/fix"), true)).toMatchObject({
      repair: "prepare",
      stageRepair: false,
    });
  });
});

describe("pluginApprovalBacklogStep", () => {
  const staged = {
    kind: "upstream",
    manifest: pluginInstallationFixture().manifest,
    source: { kind: "local", directory: "/p" },
    digest: "b".repeat(64),
    generation: "gen-2",
    updatedAt: fault.at,
  } as const;

  it("puts the missed-runs choice on the request that starts observing", () => {
    expect(pluginApprovalBacklogStep(pluginInstallationFixture())).toBe("consent");
    expect(
      pluginApprovalBacklogStep(pluginInstallationFixture({ enabled: false, status: "disabled" })),
    ).toBe("enable");
  });

  it("asks nothing for a first approval or a revision approved while off", () => {
    expect(
      pluginApprovalBacklogStep(
        pluginInstallationFixture({
          enabled: false,
          consentedDigest: null,
          status: "needs-consent",
        }),
      ),
    ).toBeNull();
    expect(
      pluginApprovalBacklogStep(
        pluginInstallationFixture({ enabled: false, status: "disabled", pendingUpdate: staged }),
      ),
    ).toBeNull();
    expect(pluginApprovalBacklogStep(pluginInstallationFixture({ pendingUpdate: staged }))).toBe(
      "consent",
    );
  });
});

describe("pluginFailureNeedsDetails", () => {
  it("points failures caused by the plugin's state, including safe mode, at its details", () => {
    const failure = (reason: string, code?: string) =>
      pluginFailureNeedsDetails(
        new PluginError({ reason, message: "m", ...(code === undefined ? {} : { code }) }),
      );
    expect(failure("disabled", "execution_disabled")).toBe(true);
    expect(failure("quarantined")).toBe(true);
    expect(failure("invalid_input")).toBe(false);
    expect(failure("permission_denied")).toBe(false);
  });
});

describe("pluginBacklogDecision", () => {
  it("asks before delivering missed runs and closes an empty gap without asking", () => {
    expect(
      pluginBacklogDecision({
        count: 4,
        afterSequence: 10,
        throughSequence: 20,
        requiresChoice: false,
      }),
    ).toEqual({ kind: "none" });
    expect(
      pluginBacklogDecision({
        count: 0,
        afterSequence: 10,
        throughSequence: 20,
        requiresChoice: true,
      }),
    ).toEqual({ kind: "resolved", eventBacklog: { policy: "skip", throughSequence: 20 } });
    expect(
      pluginBacklogDecision({
        count: 3,
        afterSequence: 10,
        throughSequence: 20,
        requiresChoice: true,
      }),
    ).toEqual({ kind: "choose", count: 3, throughSequence: 20 });
  });
});

describe("pluginRemovalNote", () => {
  it("keeps the repair folder and promises no rollback", () => {
    const note = pluginRemovalNote(
      pluginInstallationFixture({
        recovery: {
          activeSource: "upstream",
          repair: {
            workspaceId: "ws-1",
            directory: "/home/u/.t3/userdata/plugins/workspaces/inst-1/1",
            baseDigest: "a".repeat(64),
            baseGeneration: "gen-1",
            draft: "d",
          },
        },
      }),
    );
    expect(note).toContain("/home/u/.t3/userdata/plugins/workspaces/inst-1/1");
    expect(note).toContain("doesn't undo");
    expect(pluginRemovalNote(pluginInstallationFixture())).not.toContain("repair folder");
  });
});
