# Projects Tree

A dependency-free native tree example, `examples.projects-tree`. Install this
directory through Plugins, grant its metadata/settings features, then select
**Projects** in the thread sidebar. No build, npm install, storage, transcript
access, or custom HTML is needed. It installs independently of the original
declarative Projects plugin and does not modify that package.

Projects have native headings. Pinned threads lead; running work and work needing
attention stay active. Snoozed and settled shelves and quiet projects start
collapsed. Settings control empty project headings and the quiet age (1–365 days).
Forks, app-owned subagents, and independent launches nest under a parent only in
the same active project section. Parked, missing, cyclic, or deeply nested parents
leave children at the section root. Only host metadata explicitly identifying a
provider-origin subagent hides a helper. Archived threads are omitted.

The worker calls public paged `projects.list`, `threads.list`, and `settings.get`.
It registers a full replacement snapshot with `trees.register`; host semantic
change notifications refresh mounted trees. It does not poll. The host renders
rows, titles, live status, unread state, search, folds, and open/unplaced threads.
Thread nesting here is presentation; independent launches gain no ownership.
Environment and installation scope and optional logical project merging belong
to the host, so identical IDs from two environments never join in this worker.

Scans stop at 200 projects, 6000 thread metadata records, 80 page calls, or 4 MB of
encoded metadata. Live offset pages can move during a scan; duplicate IDs are
deduplicated. Snapshots stop below 1800 nodes / 120000 UTF-8 JSON bytes, reserving
complete ancestor chains. Omitted threads remain reachable through the host's
unplaced/Other rows. Hashed local node IDs keep raw thread IDs out of node keys.
A bounded diagnostic reports truncation without including titles, paths, or IDs.

Run the pure builder and enforcing SDK fixture tests from the repository root:

```sh
node --test examples/plugins/projects-tree/tree.test.mjs
```

The dedicated server `PluginWorkflowExamples.test.ts` also executes this package
in the real plugin supervisor. Its metadata and grants are fixtures. Installation,
rendering, reconnects, and multiple real environments need an integrated client
pass; these unit/runtime tests do not claim those checks.
