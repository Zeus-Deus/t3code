import {
  isPluginRecordReadOnly,
  pluginCurrentRevisionNote,
  pluginDisplayVersion,
  pluginRecordIssueMessage,
  pluginRecoveryDetails,
  pluginSourceLabel,
} from "@t3tools/client-runtime/plugins";
import type { PluginEventBacklogPolicy, PluginInstallation } from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

function closeOnDismiss(onClose: () => void, locked = false) {
  return (open: boolean) => {
    if (!open && !locked) onClose();
  };
}

/** Why a plugin is in its state, kept available after the sidebar notice is dismissed. */
export function PluginDetailsDialog(props: {
  readonly installation: PluginInstallation;
  readonly onClose: () => void;
}) {
  const { installation } = props;
  const recordIssue = pluginRecordIssueMessage(installation);
  const version = pluginDisplayVersion(installation);
  const rows = [
    ...pluginRecoveryDetails(installation, formatTime),
    ...(version === null ? [] : [{ label: "Version", value: `v${version}` }]),
    // A read-only record's source and fingerprint are placeholders around the saved record.
    ...(isPluginRecordReadOnly(installation)
      ? []
      : [
          { label: "Source", value: pluginSourceLabel(installation.source), code: true },
          { label: "Fingerprint", value: installation.digest, code: true },
        ]),
  ];
  return (
    <Dialog open onOpenChange={closeOnDismiss(props.onClose)}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{installation.manifest.name} details</DialogTitle>
          <DialogDescription>
            What T3 Code recorded about this plugin. Versions are shown as they were when each event
            happened; T3 Code does not guess which change caused a failure.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {recordIssue ? (
              <Alert variant="info" controlAlignment="first-line">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>{recordIssue}</AlertDescription>
              </Alert>
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {rows.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd
                    className={
                      row.code === true ? "break-all font-mono text-xs leading-5" : "break-words"
                    }
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Plugins are trusted code that runs with this machine user&apos;s access. They are not
              sandboxed.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button size="sm" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Running the kept previous code is not a rollback: data, files and outside effects stay as the
 * current version left them. Staging it still goes through the normal review.
 */
export function UsePreviousPluginDialog(props: {
  readonly installation: PluginInstallation;
  readonly previousVersion: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const [staging, setStaging] = useState(false);
  const { name, version } = props.installation.manifest;
  const currentRevisionNote = pluginCurrentRevisionNote(props.installation);
  return (
    <Dialog open onOpenChange={closeOnDismiss(props.onClose, staging)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Use {name} v{props.previousVersion} with current data?
          </DialogTitle>
          <DialogDescription>
            Version {props.previousVersion} uses your current settings and data. Version {version}{" "}
            may have changed them, and T3 Code can&apos;t undo that or anything either version did
            outside T3 Code, such as files, VMs or web services. If v{props.previousVersion}{" "}
            can&apos;t read the data, it should stop with an error.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">You review it next. {currentRevisionNote}</p>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={staging} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={staging}
            onClick={async () => {
              setStaging(true);
              await props.onConfirm();
              setStaging(false);
            }}
          >
            {staging ? "Preparing…" : "Continue to review"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Runs finished while the plugin could not observe them; the user decides, nothing bursts. */
export function PluginEventBacklogDialog(props: {
  readonly name: string;
  readonly count: number;
  readonly throughSequence: number;
  readonly onChoose: (eventBacklog: PluginEventBacklogPolicy) => void;
  readonly onClose: () => void;
}) {
  const runs = props.count === 1 ? "1 run" : `${props.count} runs`;
  const choose = (policy: PluginEventBacklogPolicy["policy"]) =>
    props.onChoose({ policy, throughSequence: props.throughSequence });
  return (
    <Dialog open onOpenChange={closeOnDismiss(props.onClose)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {props.name} missed {runs}
          </DialogTitle>
          <DialogDescription>
            {runs} finished in your selected projects while {props.name} wasn&apos;t receiving
            events. Delivering them lets it act on each one now, which may send messages or start
            work. Skipping starts it from new runs only.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" variant="outline" onClick={() => choose("skip")}>
            Skip missed runs
          </Button>
          <Button size="sm" onClick={() => choose("deliver")}>
            Deliver {runs}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
