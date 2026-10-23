import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function pluginThreadGroupingState(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "updatedAt"
  >,
) {
  const status = thread.activityRunStatus ?? thread.status;
  // Metadata writes must not make an old failure newer than an explicit snooze.
  const failedAt = thread.latestRunCompletedAt ?? thread.updatedAt;
  return {
    isRunning: status === "preparing" || status === "starting" || status === "running",
    needsAttention:
      thread.pendingRuntimeRequest !== null ||
      (status === "failed" &&
        (thread.snoozedAt == null ||
          DateTime.toEpochMillis(failedAt) > DateTime.toEpochMillis(thread.snoozedAt))),
  };
}
