"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import type { BatchProgress, SessionStats } from "@/lib/session-selectors";
import type { DetailTab } from "@/lib/workspace-route";
import type {
  ParallelLanesPreference,
  WorkspaceUiMode,
} from "@/lib/workspace-preferences";
import type {
  AnalysisJob,
  AnalysisMode,
  DecodePreference,
  TargetPreset,
} from "@/types/audio";

export interface WorkspaceCommandContextValue {
  currentModeLabel: string;
  currentTarget: TargetPreset | null;
  decodeLabel: string;
  decodePreference: DecodePreference;
  compatibilityDecoderAllowed: boolean;
  connectionSavingStatus: "normal" | "save-data" | "slow";
  historyEnabled: boolean;
  isDragging: boolean;
  parallelPreference: ParallelLanesPreference;
  route: {
    analysisMode: AnalysisMode;
    detailTab: DetailTab;
    uiMode: WorkspaceUiMode;
  };
  cancelActiveJobs: () => void;
  cancelJob: (jobId: string) => void;
  clearSession: () => void;
  exportCsv: () => void;
  exportJson: () => void;
  exportMarkdown: () => void;
  exportSession: () => void;
  goHome: () => void;
  openCompare: () => void;
  openHistory: () => void;
  openPicker: () => void;
  openPresetLibrary: () => void;
  openSessionPicker: () => void;
  requestClearFinished: () => void;
  requestClearSession: () => void;
  retryJob: (jobId: string) => void;
  setAnalysisMode: (mode: AnalysisMode) => void;
  setCompatibilityDecoderAllowed: (allowed: boolean) => void;
  setDecodePreference: (preference: DecodePreference) => void;
  setDetailTab: (tab: DetailTab) => void;
  setParallelPreference: (preference: ParallelLanesPreference) => void;
  setUiMode: (mode: WorkspaceUiMode) => void;
  toggleHistory: () => void;
  toggleTheme: () => void;
}

export interface WorkspaceSessionContextValue {
  batchProgress: BatchProgress | null;
  completedJobs: AnalysisJob[];
  jobs: AnalysisJob[];
  parallelLimit: number;
  queueCounts: {
    all: number;
    active: number;
    complete: number;
    issues: number;
  };
  selectedJob: AnalysisJob | null;
  sessionStats: SessionStats;
}

const WorkspaceCommandContext = createContext<WorkspaceCommandContextValue | null>(null);
const WorkspaceSessionContext = createContext<WorkspaceSessionContextValue | null>(null);

export function WorkspaceCommandProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WorkspaceCommandContextValue;
}) {
  return <WorkspaceCommandContext value={value}>{children}</WorkspaceCommandContext>;
}

export function WorkspaceSessionProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WorkspaceSessionContextValue;
}) {
  return <WorkspaceSessionContext value={value}>{children}</WorkspaceSessionContext>;
}

export function useWorkspaceCommands() {
  const value = useContext(WorkspaceCommandContext);
  if (!value) {
    throw new Error("useWorkspaceCommands must be used inside WorkspaceCommandProvider.");
  }
  return value;
}

export function useWorkspaceSession() {
  const value = useContext(WorkspaceSessionContext);
  if (!value) {
    throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider.");
  }
  return value;
}

