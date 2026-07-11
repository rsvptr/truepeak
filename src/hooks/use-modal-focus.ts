"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("aria-hidden") && element.offsetParent !== null,
  );
}

interface UseModalFocusOptions {
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  // Picks the element that receives focus when the modal opens. Falls back to
  // the panel's first focusable element, then the panel itself.
  getInitialFocus?: () => HTMLElement | null;
}

// Shared modal behavior for the confirm dialog and the drawer: body scroll
// lock with scrollbar compensation, Escape to close, a Tab trap that also
// recaptures focus lost to the page (e.g. after a backdrop click), and focus
// restore to the trigger on close. Both components used to carry their own
// copy of this; a trap fix must land in exactly one place.
export function useModalFocus({ open, panelRef, onClose, getInitialFocus }: UseModalFocusOptions) {
  const latestOnCloseRef = useRef(onClose);
  const latestInitialFocusRef = useRef(getInitialFocus);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    latestOnCloseRef.current = onClose;
    latestInitialFocusRef.current = getInitialFocus;
  }, [getInitialFocus, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusInitial = window.setTimeout(() => {
      const preferred = latestInitialFocusRef.current?.() ?? null;
      const target = preferred ?? getFocusableElements(panelRef.current)[0] ?? panelRef.current;
      target?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        latestOnCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(panelRef.current);
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeInPanel = active != null && panelRef.current?.contains(active);

      if (!activeInPanel) {
        // Focus escaped the panel (e.g. after a backdrop click left focus on
        // <body>). Pull it back in so Tab can't reach the page behind the modal.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusInitial);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      // Only restore focus if the trigger is still in the document; a removed
      // element (e.g. a deleted row) would otherwise drop focus to <body>.
      const restoreTarget = previousFocusRef.current;
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus();
      }
    };
  }, [open, panelRef]);
}
