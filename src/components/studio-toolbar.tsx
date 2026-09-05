"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Download,
  FileText,
  FolderOpen,
  History,
  MoreHorizontal,
  Plus,
  Save,
  Square,
  SunMoon,
  Trash2,
} from "lucide-react";
import { formatDuration } from "@/lib/format";
import type { BatchProgress } from "@/lib/session-selectors";
import { cn } from "@/lib/utils";
import { useBackgroundInert } from "@/hooks/use-modal-focus";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useOverlayHistoryEntry } from "@/hooks/use-overlay-history";
import { TruePeakLogo } from "@/components/truepeak-logo";
import { WorkspaceThemeToggle } from "@/components/workspace-theme-toggle";
import { useWorkspaceCommands, useWorkspaceSession } from "@/components/workspace-contexts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export type BatchProgressSummary = BatchProgress;

// Minimum vertical room (px) the More menu needs before we flip it to open
// upward instead of downward on short viewports.
const MENU_MIN_COMFORTABLE_HEIGHT = 200;
const MENU_VIEWPORT_MARGIN = 16;
const MENU_TRIGGER_GAP = 10;

export const StudioToolbar = memo(function StudioToolbar() {
  const {
    cancelActiveJobs: onCancelActive,
    currentModeLabel,
    decodeLabel,
    exportCsv: onExportCsv,
    exportJson: onExportJson,
    exportMarkdown: onExportMarkdown,
    exportSession: onExportSession,
    goHome: onGoHome,
    historyEnabled,
    openHistory: onOpenHistory,
    openPicker: onOpenPicker,
    openSessionPicker: onOpenSession,
    requestClearFinished: onClearFinished,
    requestClearSession: onClearSession,
    route: { uiMode },
    toggleHistory: onToggleHistory,
    toggleTheme,
  } = useWorkspaceCommands();
  const {
    batchProgress,
    completedJobs,
    jobs,
    parallelLimit,
    queueCounts,
  } = useWorkspaceSession();
  const activeCount = queueCounts.active;
  const completedCount = completedJobs.length;
  const finishedCount = queueCounts.complete + queueCounts.issues;
  const jobsCount = jobs.length;
  const [menuOpen, setMenuOpen] = useState(false);
  const dismissMenu = useCallback(() => setMenuOpen(false), []);
  const { closeHistoryEntry, openHistoryEntry } = useOverlayHistoryEntry(
    "more-sheet",
    dismissMenu,
  );
  // Below this width, the More menu renders as a bottom sheet instead of an
  // anchored dropdown so it never has to fight for horizontal room.
  // Hydration-safe (MOB-15): reads matchMedia during render, so the menu
  // never briefly believes it is the anchored dropdown on a phone.
  const isCompactMenu = useMediaQuery("(max-width: 640px)");
  const [menuPlacement, setMenuPlacement] = useState<"below" | "above">("below");
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wrapperRef = useRef<HTMLElement | null>(null);
  // Wraps the compact (bottom-sheet) variant's backdrop + panel. That
  // variant looks fully modal (full-screen dim, fixed sheet), so it should
  // actually block the background behind it -- see useBackgroundInert below.
  const compactMenuContainerRef = useRef<HTMLDivElement | null>(null);

  // The compact bottom-sheet visually implies the rest of the page is
  // blocked while it's open, but its Escape/outside-click/Tab handling below
  // is deliberately its own (a menu, not a dialog), so it doesn't go through
  // the full useModalFocus stack. This closes the remaining gap: without it,
  // a screen reader's virtual cursor (which Tab-based interception can't
  // catch) could still reach and activate background controls, and the
  // dimmed page underneath could still be scrolled by touch.
  useBackgroundInert(menuOpen && isCompactMenu, compactMenuContainerRef);

  const focusMenuItem = (index: number) => {
    // Unavailable items stay focusable (aria-disabled, not disabled), so
    // keyboard and screen reader users can still discover they exist.
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]') ?? [])
      .filter((item) => item.offsetParent !== null);
    if (!items?.length) {
      return;
    }

    const safeIndex = Math.max(0, Math.min(index, items.length - 1));
    items[safeIndex]?.focus();
  };

  const openMenu = useCallback(() => {
    setMenuOpen(true);
    openHistoryEntry();
  }, [openHistoryEntry]);

  const closeMenu = useCallback((returnFocus = false, afterClose?: () => void) => {
    closeHistoryEntry(() => {
      if (returnFocus) {
        window.setTimeout(() => triggerRef.current?.focus(), 0);
      }
      afterClose?.();
    });
  }, [closeHistoryEntry]);

  // Menu action wrapper: unavailable actions no-op (the item is perceivable
  // but announced disabled) and available ones close the menu after running.
  // Called from inside click handlers only, never during render.
  const runMenuAction = (enabled: boolean, action: () => void) => {
    if (!enabled) {
      return;
    }

    closeMenu(true, action);
  };

  // Collision-aware placement for the anchored (non-compact) dropdown: flip
  // above the trigger when there isn't comfortable room below, and always
  // cap the menu to whatever room actually exists so it never runs off the
  // bottom of a short viewport. Runs before paint to avoid a flash of the
  // wrong placement.
  useLayoutEffect(() => {
    if (!menuOpen || isCompactMenu) {
      return;
    }

    const updatePlacement = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - MENU_TRIGGER_GAP - MENU_VIEWPORT_MARGIN;
      const spaceAbove = rect.top - MENU_TRIGGER_GAP - MENU_VIEWPORT_MARGIN;

      if (spaceBelow < MENU_MIN_COMFORTABLE_HEIGHT && spaceAbove > spaceBelow) {
        setMenuPlacement("above");
        setMenuMaxHeight(Math.max(160, Math.floor(spaceAbove)));
      } else {
        setMenuPlacement("below");
        setMenuMaxHeight(Math.max(160, Math.floor(spaceBelow)));
      }
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    return () => window.removeEventListener("resize", updatePlacement);
  }, [menuOpen, isCompactMenu]);

  // Publish the sticky bar's real height so globals.css can reserve it as
  // scroll-padding on the scroll root. The toolbar stacks to two rows below xl
  // and grows again while a batch progress row is showing, so a hard-coded
  // offset is wrong at most widths: measure instead. Anything that scrolls into
  // view (focus, scrollIntoView, anchor jumps) then clears the bar rather than
  // parking underneath it.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") {
      return;
    }

    const publish = () => {
      const height = wrapper.getBoundingClientRect().height;
      if (height > 0) {
        document.documentElement.style.setProperty("--tp-toolbar-height", `${Math.round(height)}px`);
      }
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--tp-toolbar-height");
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const focusTimeout = window.setTimeout(() => focusMenuItem(0), 0);

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimeout);
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeMenu, menuOpen]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]') ?? [])
      .filter((item) => item.offsetParent !== null);
    if (!items?.length) {
      return;
    }

    const currentIndex = items.findIndex((item) => item === document.activeElement);

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(currentIndex + 1 >= items.length ? 0 : currentIndex + 1);
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(currentIndex <= 0 ? items.length - 1 : currentIndex - 1);
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(0);
    }

    if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(items.length - 1);
    }

    if (event.key === "Tab") {
      // Close the menu and return focus to its trigger rather than letting Tab move
      // focus to controls visually hidden behind the open menu.
      event.preventDefault();
      closeMenu(true);
    }
  };

  const menuItems = (
    <div className="grid gap-2">
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        className="md:hidden"
        onClick={() => runMenuAction(completedCount > 0, onExportCsv)}
        aria-disabled={!completedCount}
      >
        <Download className="h-4 w-4" />
        CSV
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        className="md:hidden"
        onClick={() => runMenuAction(completedCount > 0, onExportJson)}
        aria-disabled={!completedCount}
      >
        <Download className="h-4 w-4" />
        JSON
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        className="md:hidden"
        onClick={() => runMenuAction(completedCount > 0, onExportMarkdown)}
        aria-disabled={!completedCount}
      >
        <FileText className="h-4 w-4" />
        Report
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => runMenuAction(completedCount > 0, onExportSession)}
        aria-disabled={!completedCount}
      >
        <Save className="h-4 w-4" />
        Export Session
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => runMenuAction(true, onOpenSession)}
      >
        <FolderOpen className="h-4 w-4" />
        Open Session
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant={historyEnabled ? "secondary" : "primary"}
        onClick={() => runMenuAction(true, onToggleHistory)}
      >
        <History className="h-4 w-4" />
        {historyEnabled ? "Turn History Off" : "Turn History On"}
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => runMenuAction(historyEnabled, onOpenHistory)}
        aria-disabled={!historyEnabled}
      >
        <History className="h-4 w-4" />
        Open History
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        className="sm:hidden"
        onClick={() => runMenuAction(true, toggleTheme)}
      >
        <SunMoon className="h-4 w-4" />
        Toggle Theme
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => runMenuAction(finishedCount > 0, onClearFinished)}
        aria-disabled={!finishedCount}
      >
        <Trash2 className="h-4 w-4" />
        Clear Finished
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => runMenuAction(activeCount > 0, onCancelActive)}
        aria-disabled={!activeCount}
      >
        <Square className="h-4 w-4" />
        Cancel Active
      </Button>
      <Button
        data-menu-item="true"
        role="menuitem"
        type="button"
        size="sm"
        variant="danger"
        onClick={() => runMenuAction(jobsCount > 0, onClearSession)}
        aria-disabled={!jobsCount}
      >
        <Trash2 className="h-4 w-4" />
        Clear Session
      </Button>
    </div>
  );

  return (
    <header
      ref={wrapperRef}
      className="sticky top-[max(0.5rem,env(safe-area-inset-top))] z-30 sm:top-[max(1rem,env(safe-area-inset-top))]"
    >
      <Card className="relative border-[var(--line)]/65 bg-[color:var(--surface-0)]/94 px-2 py-2 shadow-[0_14px_34px_rgba(0,0,0,0.14)] sm:px-5 sm:py-4">
        <div className="flex flex-row items-center justify-between gap-2 sm:flex-col sm:items-stretch sm:gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:block sm:flex-none">
            <div className="flex shrink-0 items-center gap-2 sm:flex-wrap">
              <Button type="button" size="sm" variant="ghost" onClick={onGoHome} aria-label="Home">
                <ArrowLeft className="h-4 w-4" />
                <span className="sr-only sm:not-sr-only">Home</span>
              </Button>
              <span className="hidden h-6 w-px rounded-full bg-[var(--line)] sm:block" aria-hidden="true" />
              {/* Branding is redundant chrome once a session is open; drop it
                  on phones so the sticky bar stays Home/status/Add/More. */}
              <TruePeakLogo size="sm" subtitle="Review session" className="hidden sm:inline-flex" />
              {/* Badge chips are context, not controls, so drop them on phones
                  to keep the sticky toolbar a thin strip above the queue. */}
              <Badge className="hidden md:inline-flex">{currentModeLabel}</Badge>
              <Badge className="hidden border-[var(--line)]/80 bg-[var(--surface-1)]/70 text-[var(--muted)] md:inline-flex">
                {uiMode === "simple" ? "Simple view" : "Advanced view"}
              </Badge>
              <Badge className="hidden border-[var(--line)]/80 bg-[var(--surface-1)]/70 text-[var(--muted)] md:inline-flex">
                {decodeLabel} decode
              </Badge>
            </div>
            <div className="min-w-0 flex-1 truncate text-xs leading-5 text-[var(--muted)] sm:mt-3 sm:text-sm sm:leading-6">
              <span className="sm:hidden">
                {completedCount}/{jobsCount} ready{activeCount > 0 ? ` · ${activeCount} active` : ""}
              </span>
              <span className="hidden sm:inline">
                {jobsCount} file{jobsCount === 1 ? "" : "s"} in this session, {activeCount} in progress, {completedCount} ready to review.
                {parallelLimit && parallelLimit > 1 ? ` Runs up to ${parallelLimit} files at once.` : ""}
              </span>
            </div>
            {batchProgress ? (
              <div className="mt-2 hidden items-center gap-3 sm:flex">
                <div className="min-w-0 max-w-[420px] flex-1">
                  <Progress value={batchProgress.percent} label="Batch progress" />
                </div>
                <span className="shrink-0 text-xs tabular-nums text-[var(--muted)]">
                  {batchProgress.finished}/{batchProgress.total} done
                  {batchProgress.etaSeconds != null ? ` · ~${formatDuration(batchProgress.etaSeconds)} left` : ""}
                </span>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:flex-wrap sm:gap-2">
            <div className="hidden sm:block">
              <WorkspaceThemeToggle onToggle={toggleTheme} />
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={onOpenPicker} aria-label="Add files">
              <Plus className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">Add Files</span>
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onExportCsv} disabled={!completedCount} className="hidden md:inline-flex">
              <Download className="h-4 w-4" />
              CSV
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onExportJson} disabled={!completedCount} className="hidden md:inline-flex">
              <Download className="h-4 w-4" />
              JSON
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onExportMarkdown} disabled={!completedCount} className="hidden md:inline-flex">
              <FileText className="h-4 w-4" />
              Report
            </Button>

            <div className="relative">
              <Button
                ref={triggerRef}
                type="button"
                size="sm"
                variant="secondary"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuId}
                onClick={() => menuOpen ? closeMenu() : openMenu()}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    openMenu();
                  }
                }}
                aria-label="More session actions"
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only sm:not-sr-only">More</span>
              </Button>
              {menuOpen ? (
                isCompactMenu ? (
                  // display:contents keeps this purely a ref anchor for
                  // useBackgroundInert -- both children are position:fixed,
                  // so it must not introduce a box that could affect layout
                  // or become a fixed-position containing block itself.
                  <div ref={compactMenuContainerRef} className="contents">
                    <div
                      className="fixed inset-0 z-40 touch-none overscroll-contain bg-black/45"
                      aria-hidden="true"
                      onClick={() => closeMenu()}
                    />
                    <div
                      ref={menuRef}
                      id={menuId}
                      role="menu"
                      aria-label="Session actions"
                      onKeyDown={handleMenuKeyDown}
                      className="fixed inset-x-0 bottom-0 z-40 max-h-[calc(100dvh_-_4rem)] overflow-y-auto overscroll-contain rounded-t-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-3 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-elevated)]"
                    >
                      <div className="mx-auto mb-2 h-1.5 w-10 shrink-0 rounded-full bg-[var(--line)]" aria-hidden="true" />
                      {menuItems}
                    </div>
                  </div>
                ) : (
                  <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-label="Session actions"
                    onKeyDown={handleMenuKeyDown}
                    style={menuMaxHeight != null ? { maxHeight: `${menuMaxHeight}px` } : undefined}
                    className={cn(
                      "absolute right-0 z-40 w-[280px] max-w-[calc(100vw_-_2rem)] max-h-[calc(100dvh_-_8rem)] overflow-y-auto overscroll-contain rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[var(--shadow-elevated)]",
                      menuPlacement === "above" ? "bottom-[calc(100%+0.6rem)]" : "top-[calc(100%+0.6rem)]",
                    )}
                  >
                    {menuItems}
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
        {batchProgress ? (
          <div
            className="absolute inset-x-3 bottom-0 h-0.5 overflow-hidden rounded-full bg-[var(--line)] sm:hidden"
            role="progressbar"
            aria-label="Batch progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(batchProgress.percent)}
          >
            <span
              className="block h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: `${Math.max(0, Math.min(100, batchProgress.percent))}%` }}
            />
          </div>
        ) : null}
      </Card>
    </header>
  );
});
