// @effect-diagnostics nodeBuiltinImport:off -- snapshot bytes use Node file handles with O_NOFOLLOW.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  PLUGIN_SIDEBAR_VIEW_CAPABILITY,
  PluginError,
  PluginManifest,
  pluginRequestedCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const isPluginError = Schema.is(PluginError);
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 4 * 1_048_576;
const MAX_PACKAGE_BYTES = 32 * 1_048_576;

export const safePluginPath = (directory: string, entry: string): string => {
  if (
    !NodePath.isAbsolute(directory) ||
    entry.includes("\\") ||
    entry.includes(":") ||
    entry.includes("\0") ||
    entry.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new PluginError({
      reason: "invalid_source",
      message: "Plugin entries must be safe relative paths.",
    });
  }
  const target = NodePath.resolve(directory, entry);
  if (!target.startsWith(`${NodePath.resolve(directory)}${NodePath.sep}`)) {
    throw new PluginError({
      reason: "invalid_source",
      message: "Plugin entry escapes the package.",
    });
  }
  return target;
};

const collectSnapshot = async (directory: string) => {
  if (!NodePath.isAbsolute(directory) || !(await NodeFSP.lstat(directory)).isDirectory()) {
    throw new PluginError({
      reason: "invalid_source",
      message: "Choose an absolute plugin directory.",
    });
  }
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const name of (await NodeFSP.readdir(current)).sort()) {
      if (name === ".git") continue;
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const path = safePluginPath(directory, relative);
      const info = await NodeFSP.lstat(path);
      if (info.isSymbolicLink())
        throw new PluginError({
          reason: "invalid_source",
          message: "Plugin packages cannot contain symbolic links.",
        });
      if (info.isDirectory()) {
        // Directory count is bounded too, including empty-directory attacks.
        if (++entries > MAX_FILES)
          throw new PluginError({
            reason: "invalid_source",
            message: "Plugin package has too many entries.",
          });
        await walk(path, relative);
      } else if (info.isFile()) {
        if (
          ++entries > MAX_FILES ||
          info.size > MAX_FILE_BYTES ||
          total + info.size > MAX_PACKAGE_BYTES
        )
          throw new PluginError({
            reason: "invalid_source",
            message: "Plugin package exceeds the snapshot limit.",
          });
        const handle = await NodeFSP.open(
          path,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        );
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > MAX_FILE_BYTES)
            throw new PluginError({
              reason: "invalid_source",
              message: "Plugin file changed during snapshot.",
            });
          // A bounded read prevents a concurrently growing source from allocating without limit.
          const buffer = Buffer.alloc(opened.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const read = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
          }
          if (offset !== opened.size)
            throw new PluginError({
              reason: "changed_source",
              message: "Plugin file changed during snapshot.",
            });
          const bytes = buffer.subarray(0, offset);
          total += bytes.length;
          if (total > MAX_PACKAGE_BYTES)
            throw new PluginError({
              reason: "invalid_source",
              message: "Plugin package exceeds the snapshot limit.",
            });
          files.set(relative, bytes);
        } finally {
          await handle.close();
        }
      } else
        throw new PluginError({
          reason: "invalid_source",
          message: "Plugin packages contain only regular files and directories.",
        });
    }
  };
  let entries = 0;
  await walk(directory, "");
  const manifestBytes = files.get("t3-plugin.json");
  if (!manifestBytes || manifestBytes.length > 65_536)
    throw new PluginError({
      reason: "invalid_manifest",
      message: "A bounded t3-plugin.json manifest is required.",
    });
  let manifest: PluginManifest;
  try {
    const raw: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (typeof raw === "object" && raw !== null && "apiVersion" in raw && raw.apiVersion !== 1)
      throw new PluginError({
        reason: "incompatible",
        message: "This plugin requires another public API version.",
      });
    manifest = decodeManifest(raw);
  } catch (error) {
    if (isPluginError(error)) throw error;
    throw new PluginError({
      reason: "invalid_manifest",
      message: "The plugin manifest is invalid.",
    });
  }
  for (const collection of [
    manifest.actions.map((item) => item.id),
    manifest.views.map((item) => item.id),
    (manifest.threadStatus ?? []).map((item) => item.id),
    (manifest.sidebarViews ?? []).map((item) => item.id),
    (manifest.nativeTrees ?? []).map((item) => item.id),
    manifest.settings.map((item) => item.key),
    manifest.capabilities,
  ]) {
    if (new Set(collection).size !== collection.length)
      throw new PluginError({
        reason: "invalid_manifest",
        message: "Plugin declarations must have unique names.",
      });
  }
  for (const item of manifest.threadStatus ?? []) {
    if (
      item.viewId !== undefined &&
      !manifest.views.some((view) => view.id === item.viewId && view.placement === "side-panel")
    )
      throw new PluginError({
        reason: "invalid_manifest",
        message: "A thread status opens one of the plugin's declared side-panel views.",
      });
  }
  // Older hosts ignore the field, so the capability is what makes them refuse the plugin (required)
  // or knowingly run it without the view (optional).
  if (
    (manifest.sidebarViews ?? []).length > 0 &&
    !pluginRequestedCapabilities(manifest).includes(PLUGIN_SIDEBAR_VIEW_CAPABILITY)
  )
    throw new PluginError({
      reason: "invalid_manifest",
      message: `Sidebar views require the "${PLUGIN_SIDEBAR_VIEW_CAPABILITY}" capability.`,
    });
  for (const [declared, required] of [
    [(manifest.nativeTrees ?? []).length > 0, "ui.native-trees"],
    [manifest.views.some((view) => view.placement === "conversation"), "ui.conversation-cards"],
  ] as const) {
    if (declared && !pluginRequestedCapabilities(manifest).includes(required))
      throw new PluginError({
        reason: "invalid_manifest",
        message: `This contribution requires the "${required}" capability.`,
      });
  }
  for (const setting of manifest.settings) {
    if (
      setting.default !== undefined &&
      (setting.type === "secret" || typeof setting.default !== setting.type)
    )
      throw new PluginError({
        reason: "invalid_manifest",
        message: "A setting default must match its declared type; secrets have no public default.",
      });
  }
  for (const entry of [manifest.entry, ...manifest.views.map((view) => view.entry)]) {
    safePluginPath(directory, entry);
    if (!files.has(entry))
      throw new PluginError({
        reason: "invalid_manifest",
        message: "A declared plugin entry is missing from the snapshot.",
      });
  }
  const hash = NodeCrypto.createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${Buffer.byteLength(name)}:${name}:${bytes.length}:`);
    hash.update(bytes);
  }
  return { manifest, digest: hash.digest("hex"), files };
};

const sourceError = (error: unknown) =>
  isPluginError(error)
    ? error
    : new PluginError({ reason: "invalid_source", message: "Could not read the plugin package." });

export const inspectPluginSource = Effect.fn("plugins.inspectPluginSource")((directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const { manifest, digest } = await collectSnapshot(directory);
      return { manifest, digest };
    },
    catch: sourceError,
  }),
);

export const snapshotPluginSource = Effect.fn("plugins.snapshotPluginSource")(
  (input: { readonly directory: string; readonly destinationDirectory: string }) =>
    Effect.tryPromise({
      try: async () => {
        const snapshot = await collectSnapshot(input.directory);
        if (!NodePath.isAbsolute(input.destinationDirectory))
          throw new PluginError({
            reason: "invalid_source",
            message: "Snapshot destination must be absolute.",
          });
        await NodeFSP.mkdir(NodePath.dirname(input.destinationDirectory), { recursive: true });
        // mkdir without recursive refuses replacing any existing installation bytes.
        await NodeFSP.mkdir(input.destinationDirectory);
        try {
          for (const [relative, bytes] of snapshot.files) {
            const path = safePluginPath(input.destinationDirectory, relative);
            await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
            await NodeFSP.writeFile(path, bytes, { flag: "wx", mode: 0o400 });
          }
        } catch (error) {
          await NodeFSP.rm(input.destinationDirectory, { recursive: true, force: true });
          throw error;
        }
        return {
          directory: input.destinationDirectory,
          manifest: snapshot.manifest,
          digest: snapshot.digest,
        };
      },
      catch: sourceError,
    }),
);

export const verifyPluginSnapshot = Effect.fn("plugins.verifyPluginSnapshot")(function* (input: {
  readonly directory: string;
  readonly digest: string;
}) {
  const snapshot = yield* inspectPluginSource(input.directory);
  if (snapshot.digest !== input.digest)
    return yield* new PluginError({
      reason: "changed_source",
      message: "Installed plugin bytes changed. Refresh and consent again.",
    });
  return snapshot.manifest;
});
