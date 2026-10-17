"use client";

import { useEffect, useState, type AnimationEvent } from "react";

// Keeps an overlay mounted after `open` flips false so its exit animation can
// play, then unmounts on the panel's own animationend. The fallback timer
// covers an animationend that never arrives (animations disabled, element
// hidden). Reopening while exiting simply clears `exiting`; the same DOM is
// reused, so there is never a second mount.
export function useExitPresence(open: boolean, fallbackMs = 300) {
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) {
    setMounted(true);
  }
  const exiting = mounted && !open;

  useEffect(() => {
    if (!exiting) {
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), fallbackMs);
    return () => window.clearTimeout(timer);
  }, [exiting, fallbackMs]);

  // Attach to the animated panel; ignores animations bubbling from children.
  const onAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (exiting && event.target === event.currentTarget) {
      setMounted(false);
    }
  };

  return { mounted, exiting, onAnimationEnd };
}
