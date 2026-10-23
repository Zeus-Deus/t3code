import type { PluginClientIntent, PluginInvokeResult } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import { pluginUnsupportedIntentCount } from "./intents.ts";
import { isPluginViewHandlerName } from "./model.ts";

/**
 * A plugin view is one HTML document from the environment, shown in a sandboxed frame with an
 * opaque origin. It holds no credentials and reaches T3 only through this bridge, which can call
 * the view's own `view:<viewId>:<name>` handlers on the installation generation that served it.
 */
export const PLUGIN_VIEW_BRIDGE_VERSION = 1;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PENDING_REQUESTS = 8;
const encoder = new TextEncoder();

export interface PluginViewContext {
  readonly theme: "light" | "dark";
  /** The same `--color-*` / `--font-*` variables MCP Apps receive, applied to the root element. */
  readonly styles: Readonly<Record<string, string>>;
  readonly platform: "web" | "desktop" | "mobile";
  readonly placement: "page" | "side-panel";
  readonly view: { readonly installationId: string; readonly viewId: string };
  readonly thread: { readonly threadId: string; readonly projectId: string | null } | null;
}

export interface PluginViewHostOptions<Origin> {
  /**
   * Random per document, baked into its bridge. A page the frame navigates to shares the frame's
   * window, so the message source alone cannot tell it apart; it never sees the token.
   */
  readonly token: string;
  readonly post: (message: unknown) => void;
  readonly context: () => PluginViewContext;
  /** Where the user is when the view asks; intents in the answer are judged against it. */
  readonly captureOrigin: () => Origin;
  /** Calls `view:<viewId>:<name>`; the client fixes installation, generation, and view. */
  readonly invoke: (name: string, input: unknown, origin: Origin) => Promise<PluginInvokeResult>;
  /**
   * Intents go to the client that shows the view, never back into the frame. `unsupported` counts
   * intents from a newer plugin API that this client cannot apply.
   */
  readonly onIntents: (
    intents: ReadonlyArray<PluginClientIntent>,
    origin: Origin,
    unsupported: number,
  ) => void;
}

export interface PluginViewHost {
  /** One message the frame posted; the caller has checked it came from that frame. */
  readonly receive: (data: unknown) => void;
  readonly sendContext: () => void;
  readonly dispose: () => void;
}

const jsonBytes = (value: unknown): number => {
  try {
    return encoder.encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const isRequestId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

interface PluginViewFailure {
  readonly reason: string;
  readonly message: string;
}

export function pluginViewFailure(error: unknown): PluginViewFailure {
  if (Predicate.isObject(error) && typeof error.message === "string" && error.message !== "") {
    return {
      reason: typeof error.reason === "string" ? error.reason : "operation_failed",
      message: error.message,
    };
  }
  return { reason: "operation_failed", message: "Request failed." };
}

export function makePluginViewHost<Origin>(options: PluginViewHostOptions<Origin>): PluginViewHost {
  let disposed = false;
  let pending = 0;
  const post = (message: Record<string, unknown>) => {
    if (!disposed) options.post({ t3Plugin: PLUGIN_VIEW_BRIDGE_VERSION, ...message });
  };
  const fail = (id: number, reason: string, message: string) =>
    post({ kind: "result", id, ok: false, error: { reason, message } });

  return {
    receive: (data) => {
      if (
        disposed ||
        !Predicate.isObject(data) ||
        data.t3Plugin !== PLUGIN_VIEW_BRIDGE_VERSION ||
        data.token !== options.token
      ) {
        return;
      }
      // The transport consumes the hand-over; it carries nothing for the host.
      if (data.kind === "connect") return;
      if (data.kind === "ready") {
        post({ kind: "context", context: options.context() });
        return;
      }
      if (data.kind !== "invoke" || !isRequestId(data.id)) return;
      const id = data.id;
      if (jsonBytes(data) > MAX_MESSAGE_BYTES) {
        fail(id, "invalid_input", "Request too large.");
        return;
      }
      if (!isPluginViewHandlerName(data.name)) {
        fail(id, "invalid_handler", "Handler names use letters, digits, '.', '_' and '-'.");
        return;
      }
      if (pending >= MAX_PENDING_REQUESTS) {
        fail(id, "busy", "Too many requests in flight.");
        return;
      }
      pending += 1;
      const origin = options.captureOrigin();
      void options.invoke(data.name, data.input, origin).then(
        (result) => {
          pending -= 1;
          if (disposed) return;
          const intents = result.intents ?? [];
          const unsupported = pluginUnsupportedIntentCount(result);
          if (intents.length > 0 || unsupported > 0)
            options.onIntents(intents, origin, unsupported);
          post({
            kind: "result",
            id,
            ok: true,
            value: {
              ...(result.message === undefined ? {} : { message: result.message }),
              ...(result.data === undefined ? {} : { data: result.data }),
              ...(result.images === undefined ? {} : { images: result.images }),
            },
          });
        },
        (error: unknown) => {
          pending -= 1;
          const failure = pluginViewFailure(error);
          fail(id, failure.reason, failure.message);
        },
      );
    },
    sendContext: () => post({ kind: "context", context: options.context() }),
    dispose: () => {
      disposed = true;
    },
  };
}

/**
 * The view may load nothing from the network: data comes through the bridge, and the plugin's
 * backend owns any outside calls. Combined with the frame sandbox (scripts only, no same-origin,
 * popups, forms, or top navigation).
 */
export const PLUGIN_VIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// The author-facing API. Kept in ES5 so it runs before any author code on every engine.
// Runs before author code. The bridge makes the channel and hands the host one end, so a page the
// frame navigates to cannot reach the old document's end.
const bridgeScript = (token: string) => `(function(){"use strict";
var token=${JSON.stringify(token).replace(/</g, "\\u003c")},channel=new MessageChannel(),port=channel.port1,
pending={},next=1,ctx=null,listeners=[],resolveReady,ready=new Promise(function(r){resolveReady=r;});
function send(m){m.t3Plugin=1;m.token=token;port.postMessage(m);}
function apply(c){var root=document.documentElement;root.dataset.t3Theme=c.theme;root.style.colorScheme=c.theme;
for(var k in c.styles){if(Object.prototype.hasOwnProperty.call(c.styles,k))root.style.setProperty(k,c.styles[k]);}}
port.onmessage=function(e){var m=e.data;if(!m||m.t3Plugin!==1)return;
if(m.kind==="context"){ctx=Object.freeze(m.context);apply(ctx);resolveReady(ctx);
listeners.slice().forEach(function(f){try{f(ctx);}catch(_){}});return;}
if(m.kind==="result"){var p=pending[m.id];if(!p)return;delete pending[m.id];
if(m.ok)p[0](m.value);else{var err=new Error(m.error&&m.error.message||"Request failed.");err.reason=m.error&&m.error.reason;p[1](err);}}};
var api=Object.freeze({apiVersion:1,ready:ready,
get context(){return ctx;},
invoke:function(name,input){return new Promise(function(resolve,reject){var id=next++;pending[id]=[resolve,reject];
try{send({kind:"invoke",id:id,name:String(name),input:input});}
catch(e){delete pending[id];reject(e);}});},
onContext:function(f){listeners.push(f);return function(){var i=listeners.indexOf(f);if(i>=0)listeners.splice(i,1);};}});
Object.defineProperty(window,"t3",{value:api,writable:false,configurable:false});
window.parent.postMessage({t3Plugin:1,token:token,kind:"connect"},"*",[channel.port2]);
send({kind:"ready"});})();`;

/**
 * Puts the policy and bridge ahead of everything the author wrote, without looking for the
 * author's `<head>`: one hidden in a comment or after body content would leave the policy where
 * the browser ignores it. A later author `<head>` is dropped by the parser; its metadata still
 * lands in head.
 */
export function buildPluginViewDocument(html: string, token: string): string {
  const preamble = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PLUGIN_VIEW_CONTENT_SECURITY_POLICY}"><script>${bridgeScript(token)}</script>`;
  const body = html.replace(/^\uFEFF?\s*<!doctype[^>]*>/i, "");
  return `<!doctype html><html><head>${preamble}</head>${body}`;
}

/**
 * Mobile: React Native exposes its bridge to every frame on Android, so the WebView page nests
 * the view in a sandboxed srcdoc frame and wraps what it relays with a secret only it holds. The
 * page keeps the first port the view hands over and relays only through it, so a page the view
 * navigates to reads nothing; React Native's host still checks the token on each message.
 * The frame is created with its sandbox, srcdoc and load listener before it is inserted, so it
 * never has an initial about:blank load that could count as the view leaving its page.
 */
export function pluginViewOuterDocument(viewDocument: string, secret: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head>
<body><script>(function(){var frame=document.createElement("iframe"),secret=${JSON.stringify(secret)},loads=0,live=true,port=null;
var send=function(m){window.ReactNativeWebView.postMessage(JSON.stringify({secret:secret,message:m}));};
frame.setAttribute("sandbox","allow-scripts");
frame.addEventListener("load",function(){loads+=1;if(loads>1&&live){live=false;if(port)port.close();send({t3Plugin:1,kind:"navigated"});}});
window.addEventListener("message",function(e){var m=e.data;
if(!live||port||e.source!==frame.contentWindow||!m||m.kind!=="connect"||!e.ports||e.ports.length!==1)return;
port=e.ports[0];port.onmessage=function(ev){if(live)send(ev.data);};send(m);});
window.__t3PluginReceive=function(m){if(live&&port)port.postMessage(m);};
frame.srcdoc=${JSON.stringify(viewDocument).replace(/</g, "\\u003c")};document.body.appendChild(frame);})();</script></body></html>`;
}
