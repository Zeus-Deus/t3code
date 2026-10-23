# Plugins

Plugins add actions, workspace pages, and thread automation to an environment.
Install them on the machine running the T3 server. Connected clients use that
environment's plugins over their existing connection; they do not need a second
plugin installation.

This feature is available in builds that include the plugin host. An older
official release cannot load it. Installing a plugin does not patch the app
bundle or replace the updater.

## Install and manage

Open **Settings → Plugins** and select the destination environment. Install a
local directory containing `t3-plugin.json`, or an HTTPS Git repository. Local
paths belong to the server machine, including when you are connected remotely.
Git installations resolve to an exact revision.

Review the plugin's identity, requested capabilities, and project access, then
consent to the installed snapshot. Installing and enabling plugins requires
permission to manage access and operate the environment's terminal.

**Trust the author before enabling a plugin.** Its Node process runs as the
server's operating-system user and can access that user's files, network, and
credentials. The separate process contains crashes; it is not a security
sandbox. Project grants constrain T3's host API, not arbitrary Node code.

Actions appear in the placements declared by the plugin, such as the command
palette or a message-selection menu. Pages are available from the plugin's
settings. Composer and navigation requests affect the client that invoked the
action. An agent's invocation returns these requests as data and does not change
another person's interface.

A plugin can also show a short status for the open thread, such as **Realm live**,
in the thread header (above the composer on mobile); select it to open that
plugin's panel for the thread.

A plugin can offer another sidebar layout, such as threads grouped by project.
Once one is available, a switch appears beside the sidebar search (and in the
command palette) to move between it and **Activity**. Installing or enabling
such a plugin never switches the sidebar for you, and the choice is kept per
device. If the plugin is disabled, removed, or unavailable, the sidebar shows
Activity again without changing your open thread. It returns to your choice
when the plugin comes back. In a project layout, pinned and active threads
sit under their project. Forks and T3-delegated tasks nest under their live
parent in the same project; provider-internal subagents stay hidden.
Settled and snoozed threads stay on the shelves
below. Search and the project filter work as they do in Activity. The mobile
thread list keeps the Activity layout.

Use **Check source for changes** to stage an update. The current version stays active until
you review and approve the update. You can discard the staged update instead.
Disable a plugin to stop its process and withdraw its contributions. Removal
keeps its data unless you explicitly choose to delete it. Reinstalling the same
plugin from the same local path or Git repository restores that data. Review
the author again if the contents at that source have changed.
Repeated worker failures quarantine a plugin; address the reported error, then
restart it from plugin settings.

A failing background handler pauses event delivery without disabling the
plugin's actions. Address the reported error, then resume delivery from its
saved position in plugin settings. If events accumulated while it was stopped,
choose whether to deliver or skip the missed runs before resuming.

On mobile, long-press an assistant message's copy button for plugin text
actions. They use the whole message. Plugin side panels open as full-screen
views there, and views cannot insert into an off-screen composer; run an
insertion action from the thread instead.

## Try the examples

The repository's `examples/plugins` directories are complete plugin packages:

- **Quote Helper** inserts a review prompt from selected message text, opens
  ticket links in the preview, and provides a quote pad beside a thread.
  Set its ticket URL template for your tracker.
- **Workflow Board** saves selected text and completed turns in a plugin-owned
  page. Grant access only to projects it should manage. Automatic review
  follow-ups are off by default and can be enabled in its settings.
- **Repository Lens** shows a repository's branch, changed files, diffs, and
  recent commits beside a thread. Set its repository path to an absolute path
  on the server machine. It can draft a review request in the composer without
  sending it, and does not modify the repository or fetch from remotes. On
  mobile, insert the request from the thread's Plugins menu. The configured
  repository applies to every thread in that environment; it does not switch
  automatically with the thread's project.

Install each example by its absolute directory on the server. The examples stay
external to the host; editing one requires refreshing its installed snapshot.

## Updates and compatibility

Plugin packages and data live outside the application bundle. App updates do
not rebuild them. A failed or incompatible plugin must not prevent the app from
starting, displaying history, or updating.

Compatibility applies to the declared plugin API and supported capabilities.
Importing private T3 modules, modifying its database, or patching its DOM is
outside that contract. An unsupported capability makes the plugin unavailable;
use a compatible plugin version or wait for host support. Rich views also need
a client that supports the view host.

When a plugin needs attention, open its details in **Settings → Plugins**.
An unsupported requirement leaves the plugin unavailable while preserving your
enabled/disabled choice and its data. Records saved by a newer T3 version are
left untouched; update that environment's T3 server to use them again.

Choose **Repair with agent** to prepare an editable copy of the installed code
and open a repair draft. Review the draft, choose an agent, and send it when
ready. The draft omits setting values, secrets, and plugin data. After testing
the changes, choose **Review local fix** and approve its exact version and
permissions. Editing the repair workspace alone does not change the running
plugin.

While a local fix is active, **Check publisher for updates** still checks the
original source. You can keep the fix or review a publisher update. T3 retains
the previous code and configuration, but running it uses current plugin data:
it cannot undo changes to files, VMs, or outside services. Repair workspaces are
kept so your edits are not discarded.

Disabling or removing a plugin stops its code in T3. Resources it started
elsewhere may keep running. Choose data deletion carefully: its private files
can include large or important resources such as VM disks.

If you need to start a server without executing plugins, set
`T3CODE_PLUGINS=0` before launching it. Plugin management remains available.

See the [example author guide](../../examples/plugins/README.md) to build a
plugin.
