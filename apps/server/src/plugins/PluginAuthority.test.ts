import { expect, it } from "@effect/vitest";
import type { PluginInstallation } from "@t3tools/contracts";
import { pluginCompatibilityForHost } from "./PluginCompatibility.ts";
import { assertPluginActive } from "./PluginAuthority.ts";

const installation: PluginInstallation = {
  installationId: "test",
  generation: "one",
  manifest: {
    id: "test.plugin",
    name: "Test",
    version: "1.0.0",
    apiVersion: 1,
    entry: "plugin.mjs",
    capabilities: ["storage"],
    actions: [],
    views: [],
    settings: [],
  },
  source: { kind: "local", directory: "/fixture" },
  digest: "0".repeat(64),
  enabled: true,
  consentedDigest: "0".repeat(64),
  status: "idle",
  error: null,
  settings: {},
  grants: { capabilities: ["storage"], projectIds: [] },
  updatedAt: "2026-10-23T12:00:00.000Z",
};

it("recomputes compatibility after the host gains a previously missing requirement", () => {
  expect(assertPluginActive({ ...installation, status: "incompatible" }, "one")).toBeUndefined();
});
it("rejects a newly missing requirement despite a persisted healthy status", () => {
  expect(
    assertPluginActive(
      {
        ...installation,
        manifest: { ...installation.manifest, capabilities: ["future.required"] },
      },
      "one",
    )?.reason,
  ).toBe("incompatible");
});

it("checks the API major independently of stored status and capability support", () => {
  expect(pluginCompatibilityForHost({ apiVersion: 2, capabilities: ["storage"] }).available).toBe(
    false,
  );
  expect(pluginCompatibilityForHost({ apiVersion: 1, capabilities: ["storage"] }).available).toBe(
    true,
  );
});
