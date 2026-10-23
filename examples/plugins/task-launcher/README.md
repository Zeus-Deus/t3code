# Task Launcher

A dependency-free public SDK example, `examples.task-launcher`. Install this
directory through Plugins and grant its required features and project access.
`plugin.mjs` and its helper run as plain Node ESM without npm or a build. The
conversation card and Tasks side panel share `view.html`.

An agent in a host-verified T3 thread can invoke **Propose tasks** with:

```json
{
  "title": "Review follow-ups",
  "tasks": [{ "title": "Review tests", "prompt": "Review the changed tests and report gaps." }]
}
```

Plans contain one to six tasks, titles up to 120 characters, prompts up to 2000
characters, and at most 24 KiB of immutable plan JSON. The source thread's public
metadata supplies project, default model, and modes. Agent input cannot choose
another source, project, or ownership relationship. Outside-thread agents are
rejected. Each historical card carries only `planId` and a plain proposal summary;
full prompts stay in versioned plugin storage. Unsupported clients retain that
truthful historical summary.

A person reviews the card or opens **Task Launcher** from a thread menu. Start
uses the selected public model, runtime/interaction mode, and root or new-worktree
choice. Worktrees require the optional `worktrees.create` grant and an explicit
base ref; the host checks the ref and current permission ceilings. Launches are
independent threads. The host derives their source provenance and does not make
them owned subagents. Opening a known result uses a local client intent.

The journal records the frozen request and operation ID before calling
`threads.create`. A per-plan in-process lock serializes concurrent clicks. Started
results are reused after checking current metadata access; changed selections
cannot modify an existing launch. Start All runs up to six selected tasks
sequentially and preserves each outcome, including partial success.

**Pending or uncertain launches are never automatically retried**, including an
equal-operation-ID request after restart. A thrown create, lost response,
cancellation during create, or failed success-journal write may follow a committed
launch. The host receipt also includes a private principal/session identity that this public
consumer cannot prove on a later call. This example favors avoiding duplicate
work over automatic recovery: inspect threads before starting that work elsewhere.
It does not promise cross-click exactly-once execution or infer receipts from
matching titles. While this worker is actively launching a task, other views show
Starting. Pending journals appear as uncertain after worker restart. If cancellation
or authorization fails before the create call, the task returns to proposed only
when current host authorization and storage still permit saving that recovery;
otherwise the pending fence stays intact. Error reasons never prove no effect.

After inspecting threads, a person can **Acknowledge** an uncertain launch with a
separate confirmation naming the exact `[Task Launcher] <task title>` to check.
This retires the task as **abandoned** while retaining its frozen request, original
operation ID, and diagnostic. Acknowledgement does not cancel or delete a thread,
and that task identity can never start again. Asking an agent to propose a new
plan is deliberate new work and may duplicate a thread whose outcome was lost.

Every source, stored-plan read, model query, and known result is checked through
current public metadata authority. Foreign plans cannot be read from another
thread. Revoked or missing children lose their returned link; source revocation
rejects the read. The host remains authoritative for session operate permission
and model/mode ceilings. UI permission hints do not grant authority.

Storage is version 1, bounded below 850000 bytes, with at most 12 retained plans.
New proposals can evict the oldest resolved/proposed plan, making its old card
unavailable. Abandoned plans are also eligible for eviction. Pending and uncertain
journals are retained until acknowledged; if all slots are unresolved, new
proposals are refused. An evicted historical card cannot rebuild or restart its
plan. Unsupported/damaged storage is rejected without resetting journals. Downgrading code does not restore older data.

State changes invalidate both views and the native Tasks status. No idle polling
runs in the backend. Status is a cheap metadata-only entry point; open the view
for recorded launch outcomes. Diagnostics are fixed, bounded text and omit raw
host errors, prompts, paths, operation IDs, and credentials.

Run the enforcing SDK fixture tests from the repository root:

```sh
node --test examples/plugins/task-launcher/plugin.test.mjs
```

The server `PluginWorkflowExamples.test.ts` additionally uses real plugin workers,
SDK IPC, worker replacement, and cancellation with a held create response. Its
storage, metadata, grants, models, and thread creation are fixtures; it does not
launch real providers or check out Git worktrees. Integrated installation,
bridge/UI behavior, actual launches, persistence across server restart, and
remote/mobile connections require the root integration pass.
