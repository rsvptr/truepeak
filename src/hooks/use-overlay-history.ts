"use client";

import { useCallback, useEffect, useRef } from "react";

const OVERLAY_STATE_KEY = "__truepeakOverlay";
let overlaySequence = 0;
// A reload with an overlay open keeps the pushed entry, token and all, while
// no overlay is open any more, so the user's first Back press would be spent
// on that dead entry. It is consumed once per page load, by whichever hook
// instance mounts first, rather than once per instance.
let staleEntryChecked = false;

/**
 * Give a local overlay one browser-history entry. A hardware/browser Back
 * action dismisses it, while button, Escape, and backdrop dismissal consume
 * the extra entry before running any follow-up that may update the URL.
 */
export function useOverlayHistoryEntry(
  name: string,
  onDismiss: () => void,
) {
  const tokenRef = useRef<string | null>(null);
  const openRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const runPendingAction = useCallback(() => {
    if (fallbackTimerRef.current != null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    action?.();
  }, []);

  useEffect(() => {
    if (staleEntryChecked) {
      return;
    }
    staleEntryChecked = true;
    if (window.history.state?.[OVERLAY_STATE_KEY] != null) {
      // The URL is unchanged by an overlay entry, so this only removes the
      // entry; the router keeps the current route.
      window.history.back();
    }
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      if (openRef.current && window.history.state?.[OVERLAY_STATE_KEY] !== tokenRef.current) {
        openRef.current = false;
        tokenRef.current = null;
        onDismissRef.current();
      }
      runPendingAction();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (fallbackTimerRef.current != null) {
        window.clearTimeout(fallbackTimerRef.current);
      }
    };
  }, [runPendingAction]);

  const openHistoryEntry = useCallback(() => {
    if (openRef.current) {
      return;
    }
    overlaySequence += 1;
    const token = `${name}-${overlaySequence}`;
    tokenRef.current = token;
    openRef.current = true;
    window.history.pushState(
      { ...window.history.state, [OVERLAY_STATE_KEY]: token },
      "",
      window.location.href,
    );
  }, [name]);

  const closeHistoryEntry = useCallback((afterClose?: () => void) => {
    if (!openRef.current) {
      afterClose?.();
      return;
    }

    const token = tokenRef.current;
    openRef.current = false;
    tokenRef.current = null;
    onDismissRef.current();

    if (window.history.state?.[OVERLAY_STATE_KEY] === token) {
      pendingActionRef.current = afterClose ?? null;
      window.history.back();
      // Browsers normally dispatch popstate promptly. This fallback keeps an
      // action usable in an embedded context that suppresses that event.
      fallbackTimerRef.current = window.setTimeout(runPendingAction, 250);
    } else {
      afterClose?.();
    }
  }, [runPendingAction]);

  return { closeHistoryEntry, openHistoryEntry };
}
