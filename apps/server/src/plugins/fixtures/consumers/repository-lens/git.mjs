import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const OUTPUT_LIMIT = 32 * 1024;
const DIFF_LIMIT = 16 * 1024;

// A streaming decode omits an incomplete final UTF-8 character at the byte limit.
export function boundedText(text, limit) {
  const bytes = Buffer.from(text);
  return new TextDecoder().decode(bytes.subarray(0, limit), { stream: true });
}

function git(directory, args, signal, failureMessage, limit = OUTPUT_LIMIT) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      [
        "--no-optional-locks",
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "color.ui=false",
        "-C",
        directory,
        ...args,
      ],
      {
        signal,
        shell: false,
        encoding: "buffer",
        // execFile bounds each stream separately: together they retain at most 64 KiB.
        maxBuffer: limit,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(
            new Error("Repository inspection was cancelled or exceeded its 5-second deadline."),
          );
          return;
        }
        const truncated =
          error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && stdout.length >= limit;
        if (error && !truncated) {
          const detail = boundedText(stderr, 200)
            .split(/\r?\n/)
            .find((line) => line.trim());
          reject(new Error(detail ? `${failureMessage}\n${detail}` : failureMessage));
          return;
        }
        resolve({ text: boundedText(stdout, limit), truncated });
      },
    );
  });
}

function records(text) {
  // Only complete NUL-delimited records are safe to expose or use as pathspecs.
  return text
    .slice(0, text.lastIndexOf("\0") + 1)
    .split("\0")
    .slice(0, -1);
}

export async function inspectRepository(repositoryPath, signal) {
  if (typeof repositoryPath !== "string" || !repositoryPath.trim()) {
    throw new Error(
      "Set Repository path in Repository Lens settings to an absolute Git working-tree path on this server.",
    );
  }
  if (!NodePath.isAbsolute(repositoryPath) || repositoryPath.includes("\0")) {
    throw new Error(
      "Repository path must be an absolute path on the server machine. Update Repository Lens settings.",
    );
  }
  const root = await git(
    repositoryPath,
    ["rev-parse", "--show-toplevel"],
    signal,
    "Cannot open this repository. Check that Git is installed and Repository path in Repository Lens settings names an existing Git working tree on this server.",
  );
  if (root.truncated || !root.text.endsWith("\n")) {
    throw new Error(
      "The repository path exceeded the inspection limit. Choose a shorter Repository path in settings.",
    );
  }
  repositoryPath = NodePath.resolve(root.text.replace(/\r?\n$/, ""));
  const status = await git(
    repositoryPath,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--renames",
      "--ignore-submodules=all",
    ],
    signal,
    "Cannot read repository status. Check access to Repository path in Repository Lens settings.",
  );
  const entries = records(status.text);
  const header = entries.shift();
  if (!header?.startsWith("## ")) {
    throw new Error("Git did not return a complete repository status. Try inspecting again.");
  }
  let branch = header.slice(3).split("...")[0];
  const unborn = branch.startsWith("No commits yet on ") || branch.startsWith("Initial commit on ");
  if (unborn) branch = branch.replace(/^(?:No commits yet on |Initial commit on )/, "");
  if (branch === "HEAD (no branch)") branch = "(detached HEAD)";
  const files = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4 || entry[2] !== " ") continue;
    const file = { path: entry.slice(3), indexStatus: entry[0], worktreeStatus: entry[1] };
    if (/[RC]/.test(entry.slice(0, 2))) {
      const originalPath = entries[++index];
      if (!originalPath) break;
      file.originalPath = originalPath;
    }
    files.push(file);
  }
  const history = unborn
    ? { text: "", truncated: false }
    : await git(
        repositoryPath,
        [
          "log",
          "-5",
          "--format=%H%x00%s",
          "-z",
          "--no-notes",
          "--no-decorate",
          "--no-show-signature",
          "--",
        ],
        signal,
        "Cannot read recent commits. Try inspecting again after any ongoing Git operation finishes.",
      );
  const commitEntries = records(history.text);
  const commits = [];
  for (let index = 0; index + 1 < commitEntries.length; index += 2) {
    commits.push({ hash: commitEntries[index], subject: commitEntries[index + 1] });
  }
  return {
    repositoryPath,
    branch,
    files,
    commits,
    truncated: status.truncated || history.truncated,
  };
}

export async function repositoryDiff(snapshot, path, signal) {
  const file =
    typeof path === "string" && snapshot.files.find((candidate) => candidate.path === path);
  if (!file) {
    throw new Error(
      "Choose a file from the current changed-file list. Refresh Repository Lens if the file has changed.",
    );
  }
  if (file.indexStatus === "?" && file.worktreeStatus === "?") {
    return {
      path,
      diff: "Untracked file. Git has no tracked diff; Repository Lens does not read untracked file contents.",
      truncated: false,
    };
  }
  const paths = file.originalPath ? [path, file.originalPath] : [path];
  const parts = [];
  let truncated = false;
  for (const [label, changed, options] of [
    ["Staged changes", file.indexStatus !== " ", ["--cached"]],
    ["Unstaged changes", file.worktreeStatus !== " ", []],
  ]) {
    if (!changed) continue;
    const output = await git(
      snapshot.repositoryPath,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--ignore-submodules=all",
        ...options,
        "--",
        ...paths,
      ],
      signal,
      "Cannot read this diff. Refresh Repository Lens and choose a changed file again.",
      DIFF_LIMIT,
    );
    if (output.text) parts.push(`${label}\n${output.text}`);
    truncated ||= output.truncated;
  }
  const text =
    parts.join("\n") ||
    "Git reports no textual diff for this file. It may have changed since inspection.";
  return {
    path,
    diff: boundedText(text, DIFF_LIMIT),
    truncated: truncated || Buffer.byteLength(text) > DIFF_LIMIT,
  };
}
