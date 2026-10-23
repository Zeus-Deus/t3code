import { expect, it } from "@effect/vitest";
import { RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { pluginThreadGroupingState } from "./pluginThreadMetadata.ts";

const before = DateTime.makeUnsafe("2026-10-23T11:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
const after = DateTime.makeUnsafe("2026-10-23T13:00:00.000Z");
const shell = (overrides: Partial<Parameters<typeof pluginThreadGroupingState>[0]> = {}) => ({
  status: "idle" as const,
  pendingRuntimeRequest: null,
  updatedAt: after,
  ...overrides,
});

it.each(["preparing", "starting", "running"] as const)("recognizes %s work", (status) => {
  expect(pluginThreadGroupingState(shell({ status }))).toEqual({
    isRunning: true,
    needsAttention: false,
  });
});

it.each([
  "idle",
  "queued",
  "waiting",
  "completed",
  "interrupted",
  "cancelled",
  "rolled_back",
] as const)("does not report %s as provider work", (status) => {
  expect(pluginThreadGroupingState(shell({ status }))).toEqual({
    isRunning: false,
    needsAttention: false,
  });
});

it("uses the activity run when the latest run is queued", () => {
  expect(
    pluginThreadGroupingState(shell({ status: "queued", activityRunStatus: "running" })),
  ).toEqual({ isRunning: true, needsAttention: false });
});

it.each(["user_input", "command", "auth_refresh"] as const)(
  "keeps a snoozed %s request visible, even while nonblocking",
  (kind) => {
    expect(
      pluginThreadGroupingState(
        shell({
          status: "running",
          snoozedAt,
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("pending"),
            kind,
            createdAt: after,
            blocking: false,
          },
        }),
      ),
    ).toEqual({ isRunning: true, needsAttention: true });
  },
);

it.each([
  { status: "failed" as const, snoozedAt: undefined, latestRunCompletedAt: before, expected: true },
  { status: "failed" as const, snoozedAt, latestRunCompletedAt: before, expected: false },
  { status: "failed" as const, snoozedAt, latestRunCompletedAt: snoozedAt, expected: false },
  { status: "failed" as const, snoozedAt, latestRunCompletedAt: after, expected: true },
  { status: "failed" as const, snoozedAt, latestRunCompletedAt: undefined, expected: true },
])(
  "compares the failure edge to snooze without treating metadata updates as failure",
  ({ expected, ...input }) => {
    expect(pluginThreadGroupingState(shell(input))).toEqual({
      isRunning: false,
      needsAttention: expected,
    });
  },
);
