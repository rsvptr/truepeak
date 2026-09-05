"use client";

import { useCallback, useMemo, useState } from "react";
import { useOverlayHistoryEntry } from "@/hooks/use-overlay-history";

export type ConfirmDialogState =
  | { type: "remove-job"; jobId: string }
  | { type: "clear-finished" }
  | { type: "clear-session" }
  | { type: "clear-history" }
  | { type: "close-preset-drawer" }
  | null;

export interface UseConfirmDialogOptions {
  clearFinished: () => void;
  clearRecentSessions: () => boolean;
  clearSession: () => void;
  handleCancelDraft: () => void;
  pushUiNotice: (message: string) => void;
  removeJob: (jobId: string) => void;
  setWorkspaceDrawer: (drawer: "none" | "history") => void;
  workspaceDrawer: string;
}

export function useConfirmDialog({
  clearFinished,
  clearRecentSessions,
  clearSession,
  handleCancelDraft,
  pushUiNotice,
  removeJob,
  setWorkspaceDrawer,
  workspaceDrawer,
}: UseConfirmDialogOptions) {
  const [state, setState] = useState<ConfirmDialogState>(null);
  const dismissConfirmDialog = useCallback(() => setState(null), []);
  const { closeHistoryEntry, openHistoryEntry } = useOverlayHistoryEntry(
    "confirm-dialog",
    dismissConfirmDialog,
  );
  const closeConfirmDialog = useCallback(() => closeHistoryEntry(), [closeHistoryEntry]);
  const openConfirmDialog = useCallback((next: Exclude<ConfirmDialogState, null>) => {
    setState(next);
    openHistoryEntry();
  }, [openHistoryEntry]);
  const requestRemoveJob = useCallback((jobId: string) => {
    openConfirmDialog({ type: "remove-job", jobId });
  }, [openConfirmDialog]);
  const requestClearFinished = useCallback(() => openConfirmDialog({ type: "clear-finished" }), [openConfirmDialog]);
  const requestClearSession = useCallback(() => openConfirmDialog({ type: "clear-session" }), [openConfirmDialog]);
  const requestClearHistory = useCallback(() => openConfirmDialog({ type: "clear-history" }), [openConfirmDialog]);
  const requestClosePresetDrawer = useCallback(() => openConfirmDialog({ type: "close-preset-drawer" }), [openConfirmDialog]);

  const runConfirmedAction = useCallback(() => {
    if (!state) return;
    const requestedAction = state;
    closeHistoryEntry(() => {
      switch (requestedAction.type) {
        case "remove-job":
          removeJob(requestedAction.jobId);
          pushUiNotice("File removed from this session.");
          break;
        case "clear-finished":
          clearFinished();
          break;
        case "clear-session":
          clearSession();
          break;
        case "clear-history": {
          const cleared = clearRecentSessions();
          if (cleared && workspaceDrawer === "history") setWorkspaceDrawer("none");
          break;
        }
        case "close-preset-drawer":
          handleCancelDraft();
          setWorkspaceDrawer("none");
          break;
      }
    });
  }, [
    closeHistoryEntry,
    clearFinished,
    clearRecentSessions,
    clearSession,
    handleCancelDraft,
    pushUiNotice,
    removeJob,
    setWorkspaceDrawer,
    state,
    workspaceDrawer,
  ]);

  const copy = useMemo(() => state?.type === "remove-job"
    ? {
        title: "Remove this file?",
        description: "This removes the file and its result from the current session. You can add it again any time.",
        confirmLabel: "Remove file",
      }
    : state?.type === "clear-finished"
      ? {
          title: "Clear finished files?",
          description: "Completed, failed, and canceled items will be removed from the current queue. Active work keeps running.",
          confirmLabel: "Clear finished",
        }
      : state?.type === "clear-session"
        ? {
            title: "Clear the current session?",
            description: "This removes every queued and completed file from the current session view. Saved history stays untouched.",
            confirmLabel: "Clear session",
          }
        : state?.type === "clear-history"
          ? {
              title: "Clear saved history?",
              description: "This removes the local summary cards stored in this browser. It does not affect the current queue.",
              confirmLabel: "Clear history",
            }
          : state?.type === "close-preset-drawer"
            ? {
                title: "Discard unapplied preset changes?",
                description: "The preset drawer has edits that have not been applied yet. Closing now discards them; the active target stays unchanged.",
                confirmLabel: "Discard changes",
              }
            : null, [state]);

  return {
    closeConfirmDialog,
    confirmDialogCopy: copy,
    confirmDialogState: state,
    requestClearFinished,
    requestClearHistory,
    requestClearSession,
    requestClosePresetDrawer,
    requestRemoveJob,
    runConfirmedAction,
  };
}
