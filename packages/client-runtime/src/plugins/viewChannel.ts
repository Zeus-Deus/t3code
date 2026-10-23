import * as Predicate from "effect/Predicate";

import { PLUGIN_VIEW_BRIDGE_VERSION } from "./viewHost.ts";

/**
 * The port a view's bridge hands over, if `event` is that hand-over: right version and kind, this
 * document's token, and exactly one transferred port.
 */
export function acceptPluginViewPort(
  data: unknown,
  ports: ReadonlyArray<MessagePort>,
  token: string,
): MessagePort | null {
  return Predicate.isObject(data) &&
    data.t3Plugin === PLUGIN_VIEW_BRIDGE_VERSION &&
    data.kind === "connect" &&
    data.token === token &&
    ports.length === 1
    ? ports[0]!
    : null;
}

/**
 * Talks to one view document over the port its bridge created. Nothing is posted to the frame's
 * window: a page the frame navigates to shares that window but not the old document's port, so it
 * reads neither pending answers nor context. The host never transfers a port, and the token only
 * travels from the frame to the host.
 */
export function bindPluginViewChannel(input: {
  readonly token: string;
  readonly source: () => Window | null;
  readonly receive: (data: unknown) => void;
}) {
  let port: MessagePort | null = null;
  const onWindowMessage = (event: MessageEvent) => {
    if (port !== null || event.source === null || event.source !== input.source()) return;
    const accepted = acceptPluginViewPort(event.data, event.ports, input.token);
    if (accepted === null) return;
    port = accepted;
    port.addEventListener("message", (message) => input.receive(message.data));
    port.start();
  };
  window.addEventListener("message", onWindowMessage);
  return {
    post: (message: unknown) => port?.postMessage(message),
    dispose: () => {
      window.removeEventListener("message", onWindowMessage);
      port?.close();
      port = null;
    },
  };
}
