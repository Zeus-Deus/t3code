# Building a T3 plugin

Create a separate plugin directory containing a manifest and JavaScript entry.
`plugin.mjs` exports `activate(context)`; activation registers handlers, while
host calls run inside handler invocations.

## Hello world

A minimal `t3-plugin.json`:

```json
{
  "id": "yourname.hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "plugin.mjs",
  "capabilities": ["ui"],
  "actions": [{ "id": "hello", "title": "Say hello", "placements": ["palette"] }],
  "views": [],
  "settings": []
}
```

Its `plugin.mjs`:

```js
export function activate(ctx) {
  ctx.handle("action:hello", () => ({ message: "Hello from your plugin." }));
}
```

Install that directory through **Settings → Plugins**, review its permissions,
and enable it. Its action then appears in the command palette.

The optional `@t3tools/plugin-sdk` supplies TypeScript author types. Compile
TypeScript and bundle dependencies before installing; the host loads JavaScript
and does not install dependencies.

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

Use `ctx.dataDirectory` for private files that must survive worker restarts and
package updates. Keep runtime-generated files out of the installed snapshot.

`threads.read` returns the latest 30 messages, with each message
limited to 4,096 characters. It is a bounded snapshot, not a full-history export.

For metadata-only discovery, require `workflow.query` alongside `threads.read`
and use `projects.list`, `threads.list`, `threads.metadata`, and `models.list`.
Lists are paged; they do not promise a snapshot across concurrent edits. These
methods retain the caller's project restrictions and do not expose transcripts.
`threads.create` accepts a model, runtime and interaction modes, and a root or
worktree workspace. Worktrees also require `worktrees.create` and an explicit
base ref. The host enforces the caller's mode limits and records launch origin;
an independent launch is not an owned subagent and does not inherit cancellation.

Pass `text` to start a run immediately. With the optional
`ui.native-tree-conversations` capability, pass `brief` instead to create an
empty conversation without a run. The brief is limited to 4,000 characters and
travels, attributed to the plugin, with the first eligible human message. T3
shows the brief before sending and discloses its exact snapshot on that message;
the message itself keeps the person's text. An explicitly supplied title stays
in place. Never send both `text` and `brief`.

Each intended `send` or `create` needs a stable `idempotencyKey`; see Advanced
for retry and operation identity rules.

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
own plugin's handlers. The client injects `window.t3`; await `t3.ready` before
calling `t3.invoke(name, input)` and use `t3.onContext` to track context changes.
Handle rejected calls in the view. The page has no app stores, native bridge, or bearer token.
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
The client shows the item's `title` with your label, such as **Realm · Live**,
so keep the label a short state. An optional `icon` picks a host glyph: `monitor`,
`globe`, `bot`, `terminal`, `box`, or `activity`; any other name fails install.

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

A project node may name its conversation with `threadId`, or use `actionId` to
open one through a declared action, never both. Declare the optional
`ui.native-tree-conversations` capability and emit either field only when it
appears in `ctx.capabilities`. Clicking the project name opens its conversation
or invokes the action with only that node's `projectId`; folding has its own
control. The conversation must belong to that exact project and appears as the
heading rather than a duplicate thread row. Workers can nest directly under
the heading, including direct launched or delegated workers in another granted
project. Unrelated cross-project nesting is rejected. Reading a tree never
creates a conversation or runs an action.

With optional `ui.native-tree-projects`, a tree may declare `unplaced: "omit"`,
`create: { actionId, title }` and `emptyText`. Its header action opens T3's project
picker; selecting a project explicitly grants only that project when needed,
then invokes the action with `context.projectId`, without a thread context.
It never approves staged plugin updates.

Pass `owner: "tree:<id>"` to `threads.create` to keep that conversation in its
owning tree rather than Activity. `threads.adopt({ threadId, owner })` attaches
the same presentation ownership to an existing thread this installation created;
the host verifies its creation receipt. Ownership gives no extra authority.
Activity hides it only while this client can offer that installation's tree with
current project access; disabling or removing the plugin restores normal shelves.
Exclusive trees retain owned conversations even if a snapshot omits them.
On web and desktop, a settled thread an exclusive tree omits moves to T3's Settled
section at the bottom when its lineage parent or `launchedFrom` chain reaches a
thread the tree places, so stop listing settled workers to shelve them; a listed
row stays in the tree. Unrelated settled threads stay in Activity.
Search and native Archive remain available.

`threads.unarchive({ threadId })` restores a thread this installation created,
only inside a person-triggered action with current project access and operate
authority. An already-live thread succeeds without changing its snooze or settled
state. Reads, events and agent calls cannot restore threads. A replacement
installation cannot adopt or restore its predecessor's threads.

`collapsedByDefault` folds group and project headings. Native thread rows stay
expanded; wrap a branch in a group when it needs a foldable heading.

## Wallpapers

A view with `"placement": "wallpaper"` is drawn full-window behind the app on web and desktop.
Declare `ui.wallpapers` alongside `ui`; older hosts refuse the plugin, and older clients drop the
view. A wallpaper is chosen per device from the command palette or the plugin's settings, never
automatically, and the app falls back to its usual background whenever the plugin is unavailable.

```json
"capabilities": ["ui", "ui.wallpapers"],
"views": [
  { "id": "koi-pond", "title": "Koi Pond", "entry": "koi-pond.html", "placement": "wallpaper" }
]
```

The document never receives input and has no local intents; the bridge only supplies the theme
context. While it is shown, the app's surfaces turn translucent, so keep it calm: draw at a low
frame rate, stop when the document is hidden, and honor `prefers-reduced-motion`.

## Asking for a project

Grants can also be asked for during a conversation. Declare the required
`projects.request-access` capability and an action agents cannot call:

```json
"capabilities": ["projects.request-access", "threads.send"],
"actions": [{ "id": "project-decided", "title": "Project decided", "placements": [] }]
```

From an agent call or a person's action, name the project and a conversation
this installation owns (see `owner` under Sidebar views):

```js
const { status } = await ctx.projects.requestAccess({
  projectId,
  threadId: invocation.context.threadId,
  actionId: "project-decided",
});
```

T3 draws the card itself from the real project and plugin names and the project's
folder; nothing you send appears on it. If the name or folder changes before the
person answers, T3 refuses the grant and shows the card again, so your action only
runs on an answer to what they saw. Only a person's click on the card answers it. Agents, MCP
tools and plugin code have no way to approve, and approval grants only that
project. Web and desktop show the card; mobile does not yet, so a request can
stay `pending` until the person opens it elsewhere.

`status` is `granted` if you already hold the project, `declined` after **Not
now**, and otherwise `pending`. An id that does not exist is stored and handled
exactly the same way and simply never shows a card, so treat `pending` as "nothing
to do yet" and do not expect it to resolve. Calling again never adds a card: each
project has one request, which moves to the conversation that asked last, and a
thread shows one card at a time. An installation keeps at most 64 requests. Past
that, a new request drops your oldest unanswered one, whose card disappears until
you ask again; **Not now** answers are kept. Stop asking at your own limit:
flooding requests only loses your own cards. After **Not now** the status stays `declined` until the
person next writes in the conversation you ask from.
Other handlers (views, status, trees and events) get `permission_denied`; so does
a conversation you do not own. An undeclared or `agentCallable` action is
`invalid_input`.

The answer invokes your action as the person, like the tree picker, with
`context.projectId` and `context.threadId` of the asking conversation, and input
`{ projectAccess: "granted" | "declined" }`. Its return value is discarded, so
client requests and `card` have no effect. The grant stands even if your handler
fails, so read `requestAccess` or `projects.list` when in doubt, and store your
own progress before doing further work.

## Sending as a conversation

Pass `fromConversation: true` to `threads.send`, or to `threads.create` with
`text`, to show the message as coming from the calling conversation's project:
**From t3code**, with a link to that conversation, and the agent reading it
sees that project named on the plugin line above your text. T3 takes the sender
from the calling agent's credential or from the thread a person ran your action
on, so that action above counts. You cannot name a sender. Views, status, trees,
events and agents without a thread get `permission_denied`. The plugin needs
`threads.send` (or `threads.create`) on both projects. Editing a queued message
removes its attribution.

## Advanced

### Caller identity and lineage

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

### Retry safety and event delivery

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

Within an API major, optional fields can be added. New access to host services
requires a new capability name; an older host refuses unsupported requirements.
Clients may omit presentation contributions they do not understand and report
unsupported intents. Supply a useful message when a feature needs newer client
support. Removing fields or changing their meaning requires a new API major.

The snapshot fingerprint detects changed or corrupt packages. It does not
protect against code already running as the same operating-system user.
