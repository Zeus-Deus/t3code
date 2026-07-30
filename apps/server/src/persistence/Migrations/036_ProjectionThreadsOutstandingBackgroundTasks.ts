import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "outstanding_background_task_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN outstanding_background_task_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!columns.some((column) => column.name === "outstanding_background_task_started_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN outstanding_background_task_started_at TEXT
    `;
  }

  // Backfill from the projected activity timeline, mirroring the live
  // derivation in ProjectionPipeline exactly. Rows are replayed in the same
  // total order (unsequenced legacy rows first as a group, then sequence,
  // then createdAt/activityId — the ROW_NUMBER window below), a task counts
  // only with a well-formed string taskId, it opens at its first
  // started/progress row, and it is settled only by a task.completed that
  // replays after that opening — a stale completed that precedes the start
  // does not settle it, and a progress row after a completed does not reopen
  // it. The outer WHERE is the session gate: a thread whose provider process
  // is gone takes its children with it, so dead threads keep the 0/NULL
  // default instead of resurrecting as permanently working.
  yield* sql`
    WITH task_events AS (
      SELECT
        thread_id,
        kind,
        created_at,
        json_extract(payload_json, '$.taskId') AS task_id,
        ROW_NUMBER() OVER (
          PARTITION BY thread_id
          ORDER BY COALESCE(sequence, -1), created_at, activity_id
        ) AS ordinal
      FROM projection_thread_activities
      WHERE kind IN ('task.started', 'task.progress', 'task.completed')
        AND json_type(payload_json, '$.taskId') = 'text'
        AND TRIM(json_extract(payload_json, '$.taskId')) <> ''
    ),
    task_state AS (
      SELECT
        thread_id,
        task_id,
        MIN(CASE WHEN kind IN ('task.started', 'task.progress') THEN ordinal END)
          AS first_open_ordinal,
        MAX(CASE WHEN kind = 'task.completed' THEN ordinal END)
          AS last_completed_ordinal,
        (
          SELECT opening.created_at
          FROM task_events AS opening
          WHERE opening.thread_id = task_events.thread_id
            AND opening.task_id = task_events.task_id
            AND opening.kind IN ('task.started', 'task.progress')
          ORDER BY opening.ordinal
          LIMIT 1
        ) AS started_at
      FROM task_events
      GROUP BY thread_id, task_id
    ),
    thread_aggregate AS (
      SELECT
        thread_id,
        COUNT(*) AS open_count,
        MIN(started_at) AS oldest_started_at
      FROM task_state
      WHERE first_open_ordinal IS NOT NULL
        AND (last_completed_ordinal IS NULL OR last_completed_ordinal < first_open_ordinal)
      GROUP BY thread_id
    )
    UPDATE projection_threads
    SET
      outstanding_background_task_count = COALESCE((
        SELECT open_count
        FROM thread_aggregate
        WHERE thread_aggregate.thread_id = projection_threads.thread_id
      ), 0),
      outstanding_background_task_started_at = (
        SELECT oldest_started_at
        FROM thread_aggregate
        WHERE thread_aggregate.thread_id = projection_threads.thread_id
      )
    WHERE EXISTS (
      SELECT 1
      FROM projection_thread_sessions AS session
      WHERE session.thread_id = projection_threads.thread_id
        AND session.status IN ('starting', 'running', 'ready')
    )
  `;
});
