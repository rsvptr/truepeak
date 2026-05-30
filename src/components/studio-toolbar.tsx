"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
import { TruePeakLogo } from "@/components/truepeak-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface StudioToolbarProps {
  currentModeLabel: string;
  uiMode: "simple" | "advanced";
  decodeLabel: string;
  historyEnabled: boolean;
  completedCount: number;
  activeCount: number;
  finishedCount: number;
  jobsCount: number;
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

export function StudioToolbar({
  currentModeLabel,
  uiMode,
  decodeLabel,
  historyEnabled,
  completedCount,
  activeCount,
  finishedCount,
  jobsCount,
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
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const focusMenuItem = (index: number) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]') ?? [])
      .filter((item) => item.offsetParent !== null && !item.disabled);
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
      .filter((item) => item.offsetParent !== null && !item.disabled);
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

  return (
    <div className="sticky top-4 z-30">
      <Card className="border-[var(--line)]/65 bg-[color:var(--surface-0)]/94 px-4 py-4 shadow-[0_14px_34px_rgba(0,0,0,0.14)] sm:px-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onGoHome}>
                <ArrowLeft className="h-4 w-4" />
                Home
              </Button>
              <span className="hidden h-6 w-px rounded-full bg-[var(--line)] sm:block" aria-hidden="true" />
              <TruePeakLogo size="sm" subtitle="Review session" />
              <Badge>{currentModeLabel}</Badge>
              <Badge className="border-[var(--line)]/80 bg-[var(--surface-1)]/70 text-[var(--muted)]">
                {uiMode === "simple" ? "Simple view" : "Advanced view"}
              </Badge>
              <Badge className="border-[var(--line)]/80 bg-[var(--surface-1)]/70 text-[var(--muted)]">
                {decodeLabel} decode
              </Badge>
            </div>
            <div className="mt-3 text-sm leading-6 text-[var(--muted)]">
              {jobsCount} file{jobsCount === 1 ? "" : "s"} in this session, {activeCount} in progress, {completedCount} ready to review.
            </div>
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
                <div
                  ref={menuRef}
                  id={menuId}
                  role="menu"
                  aria-label="Session actions"
                  onKeyDown={handleMenuKeyDown}
                  className="absolute right-0 top-[calc(100%+0.6rem)] z-40 w-[280px] rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] p-3 shadow-[var(--shadow-elevated)]"
                >
                  <div className="grid gap-2">
                    <Button
                      data-menu-item="true"
                      role="menuitem"
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="md:hidden"
                      onClick={() => {
                        onExportCsv();
                        closeMenu(true);
                      }}
                      disabled={!completedCount}
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
                      onClick={() => {
                        onExportJson();
                        closeMenu(true);
                      }}
                      disabled={!completedCount}
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
                      onClick={() => {
                        onExportMarkdown();
                        closeMenu(true);
                      }}
                      disabled={!completedCount}
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
                      onClick={() => {
                        onExportSession();
                        closeMenu(true);
                      }}
                      disabled={!completedCount}
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
                      onClick={() => {
                        onOpenSession();
                        closeMenu(true);
                      }}
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
                      onClick={() => {
                        onToggleHistory();
                        closeMenu(true);
                      }}
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
                      onClick={() => {
                        onOpenHistory();
                        closeMenu(true);
                      }}
                      disabled={!historyEnabled}
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
                      onClick={() => {
                        onClearFinished();
                        closeMenu(true);
                      }}
                      disabled={!finishedCount}
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
                      onClick={() => {
                        onCancelActive();
                        closeMenu(true);
                      }}
                      disabled={!activeCount}
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
                      onClick={() => {
                        onClearSession();
                        closeMenu(true);
                      }}
                      disabled={!jobsCount}
                    >
                      <Trash2 className="h-4 w-4" />
                      Clear Session
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
