# Building a T3 plugin

These packages can be installed directly from their directories. They have no
build or install scripts. `plugin.mjs` exports `activate(context)`; activation
registers handlers, while host calls run inside handler invocations.

The optional `@t3tools/plugin-sdk` package supplies TypeScript author types.
Bundle dependencies and compile TypeScript before distributing a plugin. The
host loads ordinary JavaScript and does not install dependencies for you.

## Package

Create `t3-plugin.json` with a stable `publisher.name` identifier, a semantic
version, `apiVersion: 1`, a relative JavaScript entry, required capabilities, and
the actions, views, and settings you contribute. Use the example manifests
as starting points. The host inspects this declaration before evaluating code.

Use `optionalCapabilities` for features that can be omitted on older hosts,
and check `ctx.capabilities` before using them. A constraint the host must
understand belongs in the required `capabilities` list; older hosts can ignore
unknown manifest fields. Experimental capabilities need a new name when their
meaning changes.

Keep everything needed at runtime in the package. View entries are single,
self-contained HTML files. Installation copies a bounded, immutable snapshot;
editing your source directory does not change the running installation.

## Host API

Register action handlers with `ctx.handle("action:my-action", handler)`. A handler
receives its input plus an invocation containing `signal`, `operationId`, and
the captured project, thread, message, and selection context. Return a message,
JSON data, or client requests such as `composer.insert`, `preview.open`,
`thread.reveal`, and `view.open`.

Use `ctx.settings.get(key)` for declared settings and
`ctx.storage.get/set/delete` for plugin-owned JSON data. Treat missing storage
as `null`, version your stored format, and handle migration failures yourself.
Host history must remain readable without your plugin.

`ctx.threads.read`, `send`, and `create` operate through T3's existing domain
services. Declare the matching capabilities and obtain project grants. The host
also checks the invoking client's or agent's authority. Plugin messages visibly
identify their source.

`invocation.caller` describes the verified caller. An agent's thread identity
comes from its credential, independently of the target in `invocation.context`.
The host derives optional `subagentOf` from the caller's own thread or the
context's target by following only subagent edges to the first non-subagent
ancestor, stopping at forks; if ancestry cannot be resolved, it omits `subagentOf`
and sets `lineage: "unresolved"` on that caller or context. A deleted ancestor
may make this permanent; ask the person before allocating an ownership-sensitive
resource. Older v1 hosts omit this signal. An outside MCP agent may have
`caller.kind === "agent"` without a `caller.threadId`; do not substitute an
agent-supplied context for verified identity.
Use `ctx.dataDirectory` for private files that must survive worker restarts and
package updates. Keep runtime-generated files out of the installed snapshot.

The initial `threads.read` API returns the latest 30 messages, with each message
limited to 4,096 characters. It is a bounded snapshot, not a full-history export.

For metadata-only discovery, require `workflow.query` alongside `threads.read`
and use `projects.list`, `threads.list`, `threads.metadata`, and `models.list`.
Lists are paged; they do not promise a snapshot across concurrent edits. These
methods retain the caller's project restrictions and do not expose transcripts.
`threads.create` accepts a model, runtime and interaction modes, and a root or
worktree workspace. Worktrees also require `worktrees.create` and an explicit
base ref. The host enforces the caller's mode limits and records launch origin;
an independent launch is not an owned subagent and does not inherit cancellation.

Every `send` or `create` call requires an `idempotencyKey`, a stable name for
that effect within the invocation. For example:

```js
await ctx.threads.send({
  threadId: invocation.context.threadId,
  text: "Review the previous result without editing files.",
  idempotencyKey: "request-review",
});
```

Within the same invocation and authorized caller identity, reusing the operation
identity and effect key prevents duplicate T3 commands. The host also includes
the caller's private principal identity: an equal operation ID from another
client session does not establish a replay. Distinct intended effects need
distinct keys. This protection does not make your own HTTP requests or
filesystem writes idempotent.
Each new client action has a new operation identity. If a workflow spans
separate clicks, keep its progress in storage and make uncertain outcomes
visible rather than blindly repeating a command.

The logical effect identity survives plugin revision changes. Reusing it with
different input rejects with `code: "idempotency_conflict"`; the error may
include a prior effect handle when the caller is still authorized to see it.
Handle that conflict explicitly rather than automatically issuing another
effect. Installation generations revoke stale calls; they do not reset the
history of completed effects.

Use `ctx.events.onRunFinalized(handler)` for committed turn outcomes. Delivery
is at least once. Use `deliveryId` to deduplicate plugin data and external
effects. Keep observers bounded, respect cancellation, and avoid generating
feedback loops. Event observers never run inside orchestration replay.
New project grants start observing from the grant's event position. A person
resuming a stopped observer chooses whether to skip or deliver missed runs.

Host calls are unavailable during activation. Keep activation fast and use
`ctx.signal` or an exported `deactivate()` to dispose any resources you own.
Await host calls before returning from a handler. Outstanding calls are
cancelled when the invocation ends, so starting one with `void` does not create
background work.
Disabling revokes the installation generation and stops its worker.
It cannot automatically stop independent VMs, services or other external
resources your plugin started; provide lifecycle controls for those resources.
`ctx.log(level, message)` writes bounded diagnostics to the environment's
server logs.

## Views and agents

Declare a named page or side-panel view, then register its handlers as
`view:<view-id>:<handler>`. Views use an isolated host bridge to call only their
own plugin's handlers. See Workflow Board's `view.html` for the bridge handshake
and error handling. The page has no app stores, native bridge, or bearer token.
Use client intents to open links; navigating the frame stops its bridge.

Detect optional bridge features through `t3.features`. With `changes`, register
`t3.onChanged` and reread your snapshot when notified; retain a manual refresh
fallback for older clients. `ctx.ui.invalidate` can notify declared view, tree,
or status topics from an active handler with `ui.changes` and the corresponding
contribution permissions granted.
Notifications carry no plugin data. Local navigation uses `t3.intent` when
`local-intents` is present; it has the same client restrictions as returned intents.

An action with `ui.conversation-cards` can return a `card` naming a declared
`conversation` view, a plain historical summary, and small JSON reference data.
Keep the actual workflow in versioned plugin storage. T3 stamps the reference's
ownership; card data itself grants no authority. Check the current thread and
project before returning or changing stored state. Unsupported clients retain
the normal tool-call history, and unavailable cards show their recorded summary.
Conversation views receive `t3.context.card` when `card-context` is present and
can request a bounded height with `t3.resize` when `resize` is present.

A handler can return PNG or JPEG images by naming files inside
`ctx.dataDirectory`. The host verifies the paths, size and image signatures
before returning image content to an agent or view. See the SDK's image result
types for the limits and shape.

Only actions marked `agentCallable: true` appear in `t3_plugin_list`. Agents
call them with `t3_plugin_invoke` and a stable operation ID. An agent cannot
install plugins or invoke arbitrary view or event handlers through these tools.

## Thread status

A plugin with the `ui` capability can declare up to four `threadStatus` items,
such as `{ "id": "realm", "title": "Realm", "viewId": "realm" }`, and register
`ctx.handle("status:realm", handler)`. The client asks it with the open thread
in `invocation.context` when the thread appears, about every 30 seconds while it
stays visible, on window focus, and shortly after one of your actions or view
handlers runs for that thread. Return `{ data: { label, tone, detail } }` with a
label of at most 40 characters, a tone of `neutral`, `info`, `success`, `warning`,
or `danger`, and an optional detail shown as its description. Return
`{ data: null }` to show nothing. Report current state cheaply and without side
effects; failures are hidden rather than shown to the user. `viewId` must name
one of your side-panel views, which opens when the user selects the status.

## Sidebar views

A plugin can declare up to two `sidebarViews`, alternative layouts of the
thread sidebar that the person switches to beside **Activity**. A view is
declarative: T3 builds it from threads the client already has and draws its
own rows, menus, and keyboard behavior. No handler is called, and no thread
data reaches the plugin, so a package may contain only its manifest and an
empty `activate`.

```json
"capabilities": ["ui.sidebar-views"],
"sidebarViews": [
  { "id": "projects", "title": "Projects", "groupBy": "project",
    "quietAfterDays": 3, "emptyProjects": "show" }
]
```

`groupBy: "project"` lists each project's pinned and active threads under its
heading, using the person's project grouping and sort settings. The host nests
forks and T3-owned delegations under a live parent in the same project section,
with siblings in that sort order. Provider-internal subagents stay hidden;
ordinary thread launches have no parent relationship. Settled and
snoozed threads stay on the shared shelves. `quietAfterDays` folds projects with
nothing active and no activity for that long behind "N more projects".
`emptyProjects` decides whether projects without threads get a heading. The
host owns everything else: the open thread is never hidden, and search, the
project filter, folds, and the switch work the same for every plugin. A view is
never selected automatically.

List `ui.sidebar-views` in `capabilities` when the view is the plugin's purpose,
so older hosts refuse to install it. List it in `optionalCapabilities` if the
plugin is useful without it. Clients without support ignore the declaration,
and the mobile thread list keeps Activity.

For programmable grouping, declare `nativeTrees` with `ui.native-trees` and
register `ctx.trees.register(id, handler)`. Return a full, bounded snapshot of
groups and project or thread references. Use `workflow.query` and `threads.read`
to discover references through the public API. T3 checks their access, supplies
native titles and status, and keeps omitted threads reachable. Tree handlers run
on selection and semantic changes rather than on row renders or search input.
See the SDK for snapshot limits; do not send transcripts or copy live status
into group labels to force frequent refreshes.

`collapsedByDefault` folds group and project headings. Native thread rows stay
expanded; wrap a branch in a group when it needs a foldable heading.

## Develop and verify

Install from a local directory in an isolated development environment. After
each change, refresh and consent to the new digest. Exercise the intended
feature, disable/re-enable it, restart the server, retry the same operation,
and test a client connected remotely. Make unavailable-client behavior visible.

The SDK is the boundary: do not import T3's components, stores, Effect services,
database schema, or private transport. New host capabilities should have a real
consumer and a compatibility fixture before becoming a lasting public promise.

Keep your persistent data format versioned and refuse formats you cannot read.
Retaining an older code revision does not restore storage, files, or external
effects. The facade API major does not pin the app's Node/Electron runtime;
avoid assumptions about a particular runtime version.

The examples exercise different boundaries: Quote Helper adds selection actions
and composer requests; Workflow Board combines storage, events, and thread
automation; Repository Lens runs read-only Git commands in its Node worker and
renders the results in a side panel. Repository Lens needs an absolute repository
path in its settings on the server machine. It does not send messages, modify
files, or fetch from a remote. Node access comes from trusting the package, not
from its `ui` or `settings` capabilities.
Its configured repository is shared across threads in the environment, rather
than following the current project's path. Git's repository configuration still
applies, including any clean filters; inspect repositories whose configuration
you trust.

Within an API major, optional fields can be added. New access to host services
requires a new capability name; an older host refuses unsupported requirements.
Clients may omit presentation contributions they do not understand and report
unsupported intents. Supply a useful message when a feature needs newer client
support. Removing fields or changing their meaning requires a new API major.

The snapshot fingerprint detects changed or corrupt packages. It does not
protect against code already running as the same operating-system user.
