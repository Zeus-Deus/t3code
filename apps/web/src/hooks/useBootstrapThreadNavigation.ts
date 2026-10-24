import type { ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { useStartPageDecided } from "../components/plugins/pluginStartPage";

/**
 * Opens the server's bootstrap thread when a welcome arrives while the app is on "/". A plugin
 * start page may still replace "/", so until it has decided the welcome waits, and it opens only
 * if the app is still on "/" then.
 */
export function useBootstrapThreadNavigation(skipInitialBootstrapNavigation: boolean) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const readPathname = useEffectEvent(() => pathname);
  const startPageDecided = useStartPageDecided();
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const deferredBootstrapRef = useRef<ServerLifecycleWelcomePayload | null>(null);
  const skipInitialBootstrapNavigationRef = useRef(skipInitialBootstrapNavigation);

  const openBootstrapThread = useEffectEvent(async (payload: ServerLifecycleWelcomePayload) => {
    if (!payload.bootstrapThreadId || readPathname() !== "/") {
      return;
    }
    if (skipInitialBootstrapNavigationRef.current) {
      skipInitialBootstrapNavigationRef.current = false;
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      return;
    }
    if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
      return;
    }
    // A plugin start page may still replace "/"; this thread is only its usual fallback.
    if (!startPageDecided) {
      deferredBootstrapRef.current = payload;
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: payload.environment.environmentId,
        threadId: payload.bootstrapThreadId,
      },
      replace: true,
    });
    handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
  });

  useEffect(() => {
    const deferred = deferredBootstrapRef.current;
    if (!startPageDecided || deferred === null) return;
    deferredBootstrapRef.current = null;
    void openBootstrapThread(deferred).catch(() => undefined);
  }, [startPageDecided]);

  return openBootstrapThread;
}
