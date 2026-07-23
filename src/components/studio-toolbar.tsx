"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
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
  Trash2,
} from "lucide-react";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBackgroundInert } from "@/hooks/use-modal-focus";
import { TruePeakLogo } from "@/components/truepeak-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export interface BatchProgressSummary {
  finished: number;
  total: number;
  percent: number;
  etaSeconds: number | null;
}

interface StudioToolbarProps {
  currentModeLabel: string;
  uiMode: "simple" | "advanced";
  decodeLabel: string;
  historyEnabled: boolean;
  completedCount: number;
  activeCount: number;
  finishedCount: number;
  jobsCount: number;
  parallelLimit?: number;
  batchProgress?: BatchProgressSummary | null;
  themeControl?: ReactNode;
  onGoHome: () => void;
  onOpenPicker: () => void;
  onExportCsv: () => void;
  onExportJson: () => void;
  onExportMarkdown: () => void;
  onExportSession: () => void;
  onOpenSession: () => void;
  onToggleHistory: () => void;
  onOpenHistory: () => void;
  onClearFinished: () => void;
  onCancelActive: () => void;
  onClearSession: () => void;
}

// Minimum vertical room (px) the More menu needs before we flip it to open
// upward instead of downward on short viewports.
const MENU_MIN_COMFORTABLE_HEIGHT = 200;
const MENU_VIEWPORT_MARGIN = 16;
const MENU_TRIGGER_GAP = 10;

export function StudioToolbar({
  currentModeLabel,
  uiMode,
  decodeLabel,
  historyEnabled,
  completedCount,
  activeCount,
  finishedCount,
  jobsCount,
  parallelLimit,
  batchProgress,
  themeControl,
  onGoHome,
  onOpenPicker,
  onExportCsv,
  onExportJson,
  onExportMarkdown,
  onExportSession,
  onOpenSession,
  onToggleHistory,
  onOpenHistory,
  onClearFinished,
  onCancelActive,
  onClearSession,
}: StudioToolbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isCompactMenu, setIsCompactMenu] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<"below" | "above">("below");
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | null>(null);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
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

  const closeMenu = (returnFocus = false) => {
    setMenuOpen(false);
    if (returnFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  };

  // Menu action wrapper: unavailable actions no-op (the item is perceivable
  // but announced disabled) and available ones close the menu after running.
  // Called from inside click handlers only, never during render.
  const runMenuAction = (enabled: boolean, action: () => void) => {
    if (!enabled) {
      return;
    }

    action();
    closeMenu(true);
  };

  // Below this width, the More menu renders as a bottom sheet instead of an
  // anchored dropdown so it never has to fight for horizontal room.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(max-width: 640px)");
    setIsCompactMenu(query.matches);
    const handleChange = (event: MediaQueryListEvent) => setIsCompactMenu(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

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
  }, [menuOpen]);

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
    <div ref={wrapperRef} className="sticky top-2 z-30 sm:top-4">
      <Card className="border-[var(--line)]/65 bg-[color:var(--surface-0)]/94 px-3 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.14)] sm:px-5 sm:py-4">
        <div className="flex flex-col gap-3 sm:gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onGoHome}>
                <ArrowLeft className="h-4 w-4" />
                Home
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
            <div className="mt-2 text-xs leading-5 text-[var(--muted)] sm:mt-3 sm:text-sm sm:leading-6">
              <span className="sm:hidden">
                {completedCount}/{jobsCount} ready{activeCount > 0 ? ` · ${activeCount} active` : ""}
              </span>
              <span className="hidden sm:inline">
                {jobsCount} file{jobsCount === 1 ? "" : "s"} in this session, {activeCount} in progress, {completedCount} ready to review.
                {parallelLimit && parallelLimit > 1 ? ` Runs up to ${parallelLimit} files at once.` : ""}
              </span>
            </div>
            {batchProgress ? (
              <div className="mt-2 flex items-center gap-3">
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

          <div className="flex flex-wrap items-center gap-2">
            {themeControl}
            <Button type="button" size="sm" variant="secondary" onClick={onOpenPicker}>
              <Plus className="h-4 w-4" />
              Add Files
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
                onClick={() => setMenuOpen((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMenuOpen(true);
                  }
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
                More
              </Button>
              {menuOpen ? (
                isCompactMenu ? (
                  // display:contents keeps this purely a ref anchor for
                  // useBackgroundInert -- both children are position:fixed,
                  // so it must not introduce a box that could affect layout
                  // or become a fixed-position containing block itself.
                  <div ref={compactMenuContainerRef} className="contents">
                    <div
                      className="fixed inset-0 z-40 bg-black/45"
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
      </Card>
    </div>
  );
}
