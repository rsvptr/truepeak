"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_DROPPED_FILES, collectDroppedFiles } from "@/lib/dropped-files";
import { isModalStackOpen } from "@/hooks/use-modal-focus";

const numberFormatter = new Intl.NumberFormat("en-GB");

export interface UseFileIntakeOptions {
  enqueueFiles: (files: FileList | File[]) => number;
  importSession: (file: File) => Promise<number>;
  onFilesAdded: () => void;
  pushUiNotice: (message: string) => void;
}

export function useFileIntake({
  enqueueFiles,
  importSession,
  onFilesAdded,
  pushUiNotice,
}: UseFileIntakeOptions) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sessionInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const openSessionPicker = useCallback(() => {
    sessionInputRef.current?.click();
  }, []);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files?.length) {
      return;
    }

    const added = enqueueFiles(files);
    if (added > 0) {
      onFilesAdded();
    }
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }, [enqueueFiles, onFilesAdded]);

  const handleSessionFile = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (sessionInputRef.current) {
      sessionInputRef.current.value = "";
    }
    if (!file) {
      return;
    }

    const added = await importSession(file);
    if (added > 0) {
      onFilesAdded();
    }
  }, [importSession, onFilesAdded]);

  const handleDropTransfer = useCallback((dataTransfer: DataTransfer) => {
    void collectDroppedFiles(dataTransfer).then(({ files, truncated }) => {
      if (truncated) {
        pushUiNotice(`That drop was larger than ${numberFormatter.format(MAX_DROPPED_FILES)} files, so only the first ${numberFormatter.format(MAX_DROPPED_FILES)} were considered.`);
      }

      if (!files.length) {
        return;
      }
      const added = enqueueFiles(files);
      if (added > 0) {
        onFilesAdded();
      }
    });
  }, [enqueueFiles, onFilesAdded, pushUiNotice]);
  const dropTransferRef = useRef(handleDropTransfer);

  useEffect(() => {
    dropTransferRef.current = handleDropTransfer;
  }, [handleDropTransfer]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types?.includes("Files");
    let depth = 0;

    const handleDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setIsDragging(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const handleDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const handleDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setIsDragging(false);
      if (event.dataTransfer) dropTransferRef.current(event.dataTransfer);
    };
    const reset = () => {
      depth = 0;
      setIsDragging(false);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  useEffect(() => {
    const handleShortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isModalStackOpen()) {
        return;
      }

      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) {
        return;
      }
      const inEditable = !!target?.closest("input, textarea, select, [contenteditable='true']");

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        openPicker();
        return;
      }

      if (event.key === "/" && !inEditable && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const search = document.getElementById("queue-search");
        if (search instanceof HTMLInputElement) {
          event.preventDefault();
          search.focus();
          search.select();
        }
      }
    };

    window.addEventListener("keydown", handleShortcuts);
    return () => window.removeEventListener("keydown", handleShortcuts);
  }, [openPicker]);

  return {
    handleFiles,
    handleSessionFile,
    inputRef,
    isDragging,
    openPicker,
    openSessionPicker,
    sessionInputRef,
  };
}
