"use client";

import { useEffect, useRef, useSyncExternalStore, type RefObject } from "react";

// Native interactive elements plus the app's own interactive extensions
// (summary discloses Failure details; contenteditable is not used today but
// is included so a future editable field doesn't silently escape the trap).
const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), audio[controls], video[controls], iframe, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("aria-hidden") && element.offsetParent !== null,
  );
}

// Snapshot of an element's ancestor chain (immediate parent first, stopping
// before <body>), captured while the element is still attached. If the
// element itself is later removed from the document (e.g. a deleted queue
// row), this lets focus restoration fall back to the nearest ancestor that
// is still attached, instead of reverting to <body>.
function collectFocusAncestors(element: HTMLElement | null): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  let node = element?.parentElement ?? null;
  while (node && node !== document.body) {
    ancestors.push(node);
    node = node.parentElement;
  }
  return ancestors;
}

interface UseModalFocusOptions {
  open: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  // Picks the element that receives focus when the modal opens. Falls back to
  // the panel's first focusable element, then the panel itself.
  getInitialFocus?: () => HTMLElement | null;
  // The modal's outermost DOM node (the fixed overlay that contains both the
  // backdrop and the panel). Used to compute which background siblings get
  // `inert` while this layer is the top of the stack. Falls back to panelRef
  // when omitted, which is fine for a modal whose panel IS its outermost node.
  containerRef?: RefObject<HTMLElement | null>;
}

// --- Module-level modal stack -------------------------------------------
//
// Every open ConfirmDialog/DrawerPanel (and anything else adopting this
// hook) registers itself here. This is what makes stacking correct when a
// ConfirmDialog opens on top of an already-open DrawerPanel:
//  - Only the top-of-stack layer traps Escape/Tab (one shared document
//    listener, not one per layer).
//  - Body scroll lock is reference-counted so the lock survives until the
//    last layer closes, regardless of close order.
//  - Every layer below the top gets `inert`, and everything outside the top
//    layer's own DOM subtree (walking up to <body>) also gets `inert`, so
//    assistive tech and Tab navigation cannot reach the background or a
//    lower, temporarily non-interactive layer.
//
// Exposed for other modules (e.g. a global keyboard-shortcut handler that
// must ignore shortcuts while any modal is open):
//   isModalStackOpen()      — imperative, always current; safe to call from
//                              a raw document keydown handler outside React.
//   useModalStackOpen()     — reactive boolean for component render logic.

interface StackEntry {
  panelRef: RefObject<HTMLElement | null>;
  containerRef: RefObject<HTMLElement | null> | undefined;
  onCloseRef: RefObject<() => void>;
}

const stack: StackEntry[] = [];
const stackListeners = new Set<() => void>();

let scrollLockCount = 0;
let previousBodyOverflow = "";
let previousBodyPaddingRight = "";

// Elements we have set `inert` on, mapped to whether they already had the
// attribute before we touched them (so restoration is exact, not a blanket
// removal that could clobber an unrelated inert element).
const inertedElements = new Map<HTMLElement, boolean>();

function notifyStackListeners() {
  stackListeners.forEach((listener) => listener());
}

function acquireScrollLock() {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    previousBodyPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
  }
  scrollLockCount += 1;
}

function releaseScrollLock() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
    document.body.style.paddingRight = previousBodyPaddingRight;
  }
}

function resolveRoot(entry: StackEntry): HTMLElement | null {
  return entry.containerRef?.current ?? entry.panelRef.current;
}

function markInert(element: HTMLElement) {
  if (!inertedElements.has(element)) {
    inertedElements.set(element, element.hasAttribute("inert"));
  }
  element.setAttribute("inert", "");
}

// ARIA live regions must keep announcing even while a modal is open. An
// `inert` ancestor removes a node from the accessibility tree, so a live
// region caught by the sibling walk below would silently stop delivering its
// updates (batch-complete counts, storage-failure alerts, transient
// confirmations) to assistive tech. The app-level announcers — the completion
// announcer and WorkspaceNotices in truepeak-workbench.tsx — are direct
// children of inertable ancestors, so the walk skips any sibling that is
// *itself* a live region.
//
// This is deliberately an element-level test, not "contains a live region":
// background panels (Compare/Insights) carry their own nested role=status
// regions that SHOULD go inert with the rest of the background, and exempting a
// whole subtree just because it holds one would leave interactive background
// content reachable behind the modal. The typeof guard lets the walk degrade
// safely (fall back to inerting) in any environment without Element.matches.
const LIVE_REGION_SELECTOR =
  '[role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], [aria-live]:not([aria-live="off"]), output';

function isLiveRegion(element: HTMLElement): boolean {
  return typeof element.matches === "function" && element.matches(LIVE_REGION_SELECTOR);
}

// Restore every element we previously marked, then re-derive inertness from
// the current stack. Simpler and more robust than diffing old vs. new sets.
function recomputeInertness() {
  inertedElements.forEach((hadInertBefore, element) => {
    if (!hadInertBefore) {
      element.removeAttribute("inert");
    }
  });
  inertedElements.clear();

  if (stack.length === 0) {
    return;
  }

  const top = stack[stack.length - 1];
  const topRoot = resolveRoot(top);

  // Every layer below the top becomes inert directly (per UX-023: lower
  // modal layers are made inert rather than left merely "behind" the trap).
  for (const entry of stack) {
    if (entry === top) {
      continue;
    }
    const root = resolveRoot(entry);
    if (root) {
      markInert(root);
    }
  }

  if (!topRoot) {
    return;
  }

  // Walk from the top layer's root up to <body>, marking every sibling
  // along the way inert. This removes the rest of the application (and any
  // already-inerted lower layer, redundantly but harmlessly) from both Tab
  // order and the accessibility tree while the top layer is open.
  let node: HTMLElement | null = topRoot;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) {
      break;
    }
    for (const child of Array.from(parent.children)) {
      if (child === node || !(child instanceof HTMLElement)) {
        continue;
      }
      // Keep app-level live regions in the accessibility tree so their
      // announcements still reach assistive tech while the modal is open.
      if (isLiveRegion(child)) {
        continue;
      }
      markInert(child);
    }
    node = parent;
  }
}

function handleDocumentKeyDown(event: KeyboardEvent) {
  if (stack.length === 0) {
    return;
  }

  // Only the top-of-stack layer ever reacts. A nested confirm dialog opened
  // from within an open drawer must not let Escape (or a wrapped Tab cycle)
  // also reach the drawer's own listener underneath it.
  const top = stack[stack.length - 1];

  if (event.key === "Escape") {
    event.preventDefault();
    top.onCloseRef.current();
    return;
  }

  if (event.key !== "Tab") {
    return;
  }

  const panel = top.panelRef.current;
  const focusable = getFocusableElements(panel);
  if (!focusable.length) {
    event.preventDefault();
    panel?.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeInPanel = active != null && panel?.contains(active);

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
}

function pushStackEntry(entry: StackEntry) {
  const wasEmpty = stack.length === 0;
  stack.push(entry);
  acquireScrollLock();
  if (wasEmpty) {
    document.addEventListener("keydown", handleDocumentKeyDown);
  }
  recomputeInertness();
  notifyStackListeners();
}

function popStackEntry(entry: StackEntry) {
  const index = stack.indexOf(entry);
  if (index !== -1) {
    stack.splice(index, 1);
  }
  releaseScrollLock();
  if (stack.length === 0) {
    document.removeEventListener("keydown", handleDocumentKeyDown);
  }
  recomputeInertness();
  notifyStackListeners();
}

/** Imperative, always-current check. Safe to call from outside React (e.g. a
 * raw document keydown handler deciding whether to run a global shortcut). */
export function isModalStackOpen(): boolean {
  return stack.length > 0;
}

/** Number of currently open modal layers, top of stack last. */
export function getModalStackDepth(): number {
  return stack.length;
}

function subscribeToModalStack(listener: () => void): () => void {
  stackListeners.add(listener);
  return () => {
    stackListeners.delete(listener);
  };
}

function getModalStackServerSnapshot(): boolean {
  return false;
}

/** Reactive boolean for component render logic — true while any modal layer
 * (ConfirmDialog, DrawerPanel, or anything else using this hook) is open. */
export function useModalStackOpen(): boolean {
  return useSyncExternalStore(subscribeToModalStack, isModalStackOpen, getModalStackServerSnapshot);
}

// Shared modal behavior for the confirm dialog and the drawer: stack-aware
// Escape/Tab handling (only the top layer responds), reference-counted body
// scroll lock, inert background/lower-layer management, and focus restore to
// the trigger on close. Both components used to carry their own copy of
// this; a trap fix must land in exactly one place.
export function useModalFocus({
  open,
  panelRef,
  onClose,
  getInitialFocus,
  containerRef,
}: UseModalFocusOptions) {
  const latestOnCloseRef = useRef(onClose);
  const latestInitialFocusRef = useRef(getInitialFocus);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previousFocusAncestorsRef = useRef<HTMLElement[]>([]);

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
    previousFocusAncestorsRef.current = collectFocusAncestors(previousFocusRef.current);

    const entry: StackEntry = {
      panelRef,
      containerRef,
      onCloseRef: latestOnCloseRef,
    };

    pushStackEntry(entry);

    const focusInitial = window.setTimeout(() => {
      const preferred = latestInitialFocusRef.current?.() ?? null;
      const target = preferred ?? getFocusableElements(panelRef.current)[0] ?? panelRef.current;
      target?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusInitial);
      popStackEntry(entry);
      // Only restore focus directly to the trigger if it's still in the
      // document; a removed element (e.g. a deleted row) would otherwise
      // drop focus to <body>. By the time we get here, popStackEntry has
      // already re-derived inertness, so a now-top lower layer is no longer
      // inert and can legitimately receive focus back.
      const restoreTarget = previousFocusRef.current;
      if (restoreTarget && document.contains(restoreTarget)) {
        restoreTarget.focus();
        return;
      }

      // The trigger itself is gone (e.g. its whole row was removed after a
      // confirmed destructive action). Fall back to the nearest ancestor
      // that is still attached so a keyboard/screen-reader user lands on a
      // sensible surviving surface (the list/section that used to contain
      // the trigger) instead of silently losing focus to <body>.
      const fallback = previousFocusAncestorsRef.current.find((ancestor) => document.contains(ancestor));
      if (!fallback) {
        return;
      }

      const hadTabIndex = fallback.hasAttribute("tabindex");
      if (!hadTabIndex) {
        fallback.setAttribute("tabindex", "-1");
      }
      fallback.focus();
      if (!hadTabIndex) {
        // Programmatic-only focus target: drop the temporary tabindex once
        // focus moves on so it doesn't linger in the page's Tab order.
        const clearTemporaryTabIndex = () => {
          fallback.removeAttribute("tabindex");
          fallback.removeEventListener("blur", clearTemporaryTabIndex);
        };
        fallback.addEventListener("blur", clearTemporaryTabIndex, { once: true });
      }
    };
  }, [open, panelRef, containerRef]);
}

// For UI that renders a modal-STYLED overlay (a full-screen backdrop plus a
// panel) but intentionally keeps its own bespoke, non-dialog interaction
// model — e.g. a role="menu" bottom sheet with roving-tabindex and
// Tab-closes-the-menu behavior, rather than a Tab-trapped dialog — adopting
// the full useModalFocus stack (its own Escape/Tab trapping) would fight
// with that model. useBackgroundInert covers just the two pieces still
// needed to make the overlay actually block the page the way it visually
// implies: every sibling along the path from `rootRef` up to <body> gets
// `inert` (so a screen reader's virtual cursor, not just Tab order, cannot
// reach the background) and body scroll is locked (via the same
// reference-counted lock the full modal stack uses), for as long as
// `active` is true. It does not touch focus, Escape, or Tab handling —
// callers keep whatever interaction model they already have.
export function useBackgroundInert(active: boolean, rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    const locallyInerted = new Map<HTMLElement, boolean>();
    let node: HTMLElement | null = root;
    while (node && node !== document.body) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) {
        break;
      }
      for (const child of Array.from(parent.children)) {
        if (child === node || !(child instanceof HTMLElement)) {
          continue;
        }
        if (isLiveRegion(child)) {
          continue;
        }
        if (!locallyInerted.has(child)) {
          locallyInerted.set(child, child.hasAttribute("inert"));
        }
        child.setAttribute("inert", "");
      }
      node = parent;
    }

    acquireScrollLock();

    return () => {
      releaseScrollLock();
      locallyInerted.forEach((hadInertBefore, element) => {
        if (!hadInertBefore) {
          element.removeAttribute("inert");
        }
      });
    };
  }, [active, rootRef]);
}
