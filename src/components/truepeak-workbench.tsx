"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import dynamic from "next/dynamic";
import {
  ArrowUpDown,
  AudioLines,
  BarChart3,
  FolderOpen,
  Gauge,
  Info,
  Plus,
  RefreshCcw,
  Search,
  Waves,
} from "lucide-react";
import { AdvancedQueueRow } from "@/components/advanced-queue-row";
import { HistoryPreferenceCard, RecentSessionsPanel } from "@/components/history-panels";
import { WorkbenchEmptyState as EmptyState } from "@/components/workbench-empty-state";
import { WorkspaceMetricTile as MetricTile } from "@/components/workspace-metric-tile";
import { WorkspaceNotices } from "@/components/workspace-notices";
import { WorkspaceThemeToggle as ThemeToggle } from "@/components/workspace-theme-toggle";
import {
  WorkspaceCommandProvider,
  WorkspaceSessionProvider,
  type WorkspaceCommandContextValue,
  type WorkspaceSessionContextValue,
} from "@/components/workspace-contexts";
import { useAnalysisSettings } from "@/hooks/use-analysis-settings";
import { useCompletionAnnouncer } from "@/hooks/use-completion-announcer";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useConnectionSavingStatus } from "@/hooks/use-data-saver";
import { useFileIntake } from "@/hooks/use-file-intake";
import { useQueueView } from "@/hooks/use-queue-view";
import { useTruePeakAnalyzer } from "@/hooks/use-truepeak-analyzer";
import { useNormalizeWorkspaceRoute, useWorkspaceRoute } from "@/hooks/use-workspace-route";
import {
  formatLufs,
  formatPeakDbtp,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  DecodePreference,
} from "@/types/audio";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DrawerPanel } from "@/components/drawer-panel";
import { HomeStage } from "@/components/home-stage";
import { InspectorPanel } from "@/components/inspector-panel";
import { SimpleResultsTable } from "@/components/simple-results-table";
import { StudioToolbar } from "@/components/studio-toolbar";
import { TruePeakLogo } from "@/components/truepeak-logo";
import {
  type QueueFilter,
  type QueueSort,
  type WorkspaceTab,
} from "@/lib/workspace-route";
import {
  readHistoryPreference,
  readHistoryPreferenceServerSnapshot,
  readParallelPreference,
  readParallelPreferenceServerSnapshot,
  readThemePreference,
  readThemePreferenceHydrationSnapshot,
  subscribeHistoryPreference,
  subscribeParallelPreference,
  subscribeThemePreference,
  type ParallelLanesPreference,
  writeHistoryPreference,
  writeParallelPreference,
  writeThemePreference,
} from "@/lib/workspace-preferences";
import { WorkspaceSummaryRail } from "@/components/workspace-summary-rail";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export { WorkspaceNotices };

function ThemeSynchronizer() {
  const theme = useSyncExternalStore(
    subscribeThemePreference,
    readThemePreference,
    readThemePreferenceHydrationSnapshot,
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const color = theme === "light" ? "#f6faf8" : "#071412";
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = color;
    });
  }, [theme]);

  return null;
}

const LARGE_WORKSPACE_QUERY = "(min-width: 1024px)";

function readLargeWorkspace() {
  return typeof window !== "undefined" && window.matchMedia(LARGE_WORKSPACE_QUERY).matches;
}

function subscribeLargeWorkspace(listener: () => void) {
  const media = window.matchMedia(LARGE_WORKSPACE_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

// The static shell never has a selected job, so the inspector breakpoint
// cannot change its generated markup. Reading the real client breakpoint for
// hydration therefore avoids an otherwise guaranteed corrective commit while
// preserving a deterministic server render.
function readLargeWorkspaceHydrationSnapshot() {
  return typeof window === "undefined" ? false : readLargeWorkspace();
}

// CompareStudio and SessionInsightsPanel only matter once the Compare/Insights
// session tab is opened, and PresetLibraryDrawer only once the preset drawer
// is opened, so keep all three out of the initial workbench chunk (NEXT-06).
// The tab panels keep SSR (default); the drawer is closed by default and
// renders nothing until then, so it can skip SSR entirely.
const CompareStudio = dynamic(
  () => import("@/components/compare-studio").then((module) => module.CompareStudio),
  {
    loading: () => (
      <div
        className="min-h-[420px] w-full animate-pulse rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)]"
        aria-hidden="true"
      />
    ),
  },
);

const SessionInsightsPanel = dynamic(
  () => import("@/components/session-insights").then((module) => module.SessionInsightsPanel),
  {
    loading: () => (
      <div
        className="min-h-[420px] w-full animate-pulse rounded-[24px] border border-[var(--line)] bg-[var(--surface-1)]"
        aria-hidden="true"
      />
    ),
  },
);

const PresetLibraryDrawer = dynamic(
  () => import("@/components/preset-library-drawer").then((module) => module.PresetLibraryDrawer),
  { ssr: false, loading: () => null },
);

const SUPPORTED_FORMATS = [
  "WAV",
  "RF64",
  "AIFF",
  "AIFC",
  "MP3",
  "AAC/M4A",
  "FLAC",
  "OGG/Opus",
];
const numberFormatter = new Intl.NumberFormat("en-GB");
const QUEUE_FILTERS: Array<{ id: QueueFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "complete", label: "Complete" },
  { id: "issues", label: "Issues" },
];
const QUEUE_SORTS: Array<{ id: QueueSort; label: string }> = [
  { id: "recent", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "status", label: "By status" },
  { id: "integrated", label: "Integrated LUFS" },
  { id: "truePeak", label: "True peak" },
  { id: "name", label: "File name" },
];
const SESSION_TABS: Array<{ id: WorkspaceTab; label: string; icon: typeof Gauge }> = [
  { id: "queue", label: "Queue", icon: Gauge },
  { id: "compare", label: "Compare", icon: BarChart3 },
  { id: "insights", label: "Insights", icon: Info },
];
const DECODE_PREFERENCES: Array<{
  id: DecodePreference;
  label: string;
  description: string;
}> = [
  {
    id: "auto",
    label: "Auto",
    description:
      "Uses the strict parser for PCM containers and the fastest decoder that still reads compressed files reliably.",
  },
  {
    id: "browser-first",
    label: "Browser first",
    description:
      "Decodes MP3, AAC, FLAC, and Opus through the browser first, and drops to compatibility decoding only if that fails.",
  },
  {
    id: "compatibility-first",
    label: "Compatibility first",
    description:
      "Sends compressed files through the compatibility decoder first. Slower, and it downloads a decoder of about 31 MB (32,232,419 bytes) the first time it runs, but worth it when a browser's own codecs give inconsistent results.",
  },
];

function formatDecodePreferenceLabel(value: DecodePreference) {
  return DECODE_PREFERENCES.find((option) => option.id === value)?.label ?? "Auto";
}

function shouldIgnoreQueueNavigationTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.closest("[data-queue-nav='true']")) {
    return false;
  }

  return !!target.closest(
    "a, button, input, select, textarea, summary, [contenteditable='true'], [role='button'], [role='menuitem'], [role='tab']",
  );
}

export function TruePeakWorkbench() {
  const {
    activeTarget,
    decodePreference,
    draftIsDirty,
    draftIsModified,
    draftPreviewTarget,
    draftResolution,
    draftStatus,
    handleApplyDraft,
    handleCancelDraft,
    handleCustomTargetLufsChange,
    handleCustomTruePeakChange,
    handlePolicyChange,
    handleResetToPublished,
    handleSelectPreset,
    handleToleranceChange,
    persistedAnalysisMode,
    recoveryWritesAllowed,
    retrySettingsPersistence,
    setDecodePreference,
    setPersistedAnalysisMode,
    settingsPersistenceIssue,
    targetState,
  } = useAnalysisSettings();
  const workspaceRoute = useWorkspaceRoute({
    onAnalysisModeChange: setPersistedAnalysisMode,
    persistedAnalysisMode,
  });
  const {
    activeWorkspaceTab,
    analysisMode,
    compareDirection,
    compareFilter,
    compareSort,
    compareView,
    deferredSearchQuery,
    detailTab,
    queueFilter,
    queueSearchDraft,
    queueSort,
    referenceId,
    resetQueueView,
    selectedJobId,
    setAnalysisMode,
    setCompareFilter,
    setCompareSort,
    setCompareView,
    setDetailTab,
    setQueueFilter,
    setQueueSearchDraft,
    setQueueSort,
    setReferenceId,
    setUiMode,
    setWorkspaceDrawer,
    setWorkspaceScreen,
    setWorkspaceTab,
    uiMode,
    updateWorkspaceRoute,
    workspaceDrawer,
    workspaceScreen,
    workspaceTab,
  } = workspaceRoute;
  const historyEnabled = useSyncExternalStore(
    subscribeHistoryPreference,
    readHistoryPreference,
    readHistoryPreferenceServerSnapshot,
  );
  const parallelPreference = useSyncExternalStore<ParallelLanesPreference>(
    subscribeParallelPreference,
    readParallelPreference,
    readParallelPreferenceServerSnapshot,
  );
  const connectionSavingStatus = useConnectionSavingStatus();
  const [compatibilityDecoderOptIn, setCompatibilityDecoderOptIn] = useState(false);
  const connectionSavingActive = connectionSavingStatus !== "normal";
  const compatibilityDecoderAllowed = !connectionSavingActive || compatibilityDecoderOptIn;
  const setParallelPreference = useCallback((next: ParallelLanesPreference) => {
    writeParallelPreference(next);
  }, []);
  const toggleTheme = useCallback(() => {
    writeThemePreference(readThemePreference() === "dark" ? "light" : "dark");
  }, []);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const uiNoticeTimeoutRef = useRef<number | null>(null);
  const isLargeScreen = useSyncExternalStore(
    subscribeLargeWorkspace,
    readLargeWorkspace,
    readLargeWorkspaceHydrationSnapshot,
  );
  const mainRef = useRef<HTMLElement | null>(null);
  const workspaceTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const advancedInspectorSectionRef = useRef<HTMLElement | null>(null);
  const advancedInspectorHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingInspectorFocusRef = useRef(false);
  const [inspectorFocusRequest, setInspectorFocusRequest] = useState(0);
  // Roving-focus state for queue arrow navigation (UX-024): the region wrapping
  // the rows, the job whose row should receive focus after the next commit, and
  // a tick that drives the focus effect independently of selection resolution.
  const queueRegionRef = useRef<HTMLDivElement | null>(null);
  const pendingQueueFocusRef = useRef<string | null>(null);
  const [queueFocusTick, setQueueFocusTick] = useState(0);

  useEffect(() => {
    mainRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  const setHistoryEnabled = useCallback((next: boolean) => {
    if (!next && workspaceDrawer === "history") {
      updateWorkspaceRoute({ drawer: null });
    }

    writeHistoryPreference(next);
  }, [updateWorkspaceRoute, workspaceDrawer]);

  const toggleHistoryEnabled = useCallback(() => {
    setHistoryEnabled(!historyEnabled);
  }, [historyEnabled, setHistoryEnabled]);

  useEffect(() => {
    return () => {
      if (uiNoticeTimeoutRef.current) {
        window.clearTimeout(uiNoticeTimeoutRef.current);
      }
    };
  }, []);

  const pushUiNotice = useCallback((message: string) => {
    setUiNotice(message);
    if (uiNoticeTimeoutRef.current) {
      window.clearTimeout(uiNoticeTimeoutRef.current);
      uiNoticeTimeoutRef.current = null;
    }

    uiNoticeTimeoutRef.current = window.setTimeout(() => {
      setUiNotice(null);
      uiNoticeTimeoutRef.current = null;
    }, 3600);
  }, []);

  const connectionNoticeShownRef = useRef(false);
  useEffect(() => {
    if (!connectionSavingActive || connectionNoticeShownRef.current) {
      return;
    }
    connectionNoticeShownRef.current = true;
    pushUiNotice(
      `${connectionSavingStatus === "save-data" ? "Data Saver is on" : "A slow connection was detected"}. The approximately 31 MB compatibility decoder will stay off unless you allow it in Advanced options.`,
    );
  }, [connectionSavingActive, connectionSavingStatus, pushUiNotice]);

  const {
    jobs,
    completedJobs,
    restoreSettled,
    recentSessions,
    notice,
    persistenceIssue,
    workerCircuitIssue,
    parallelLimit,
    enqueueFiles,
    cancelJob,
    cancelActiveJobs,
    retryJob,
    retryIssues,
    retryAnalysis,
    removeJob,
    clearFinished,
    clearSession,
    clearRecentSessions,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportSession,
    importSession,
  } = useTruePeakAnalyzer(activeTarget, {
    allowCompatibilityDecoder: compatibilityDecoderAllowed,
    analysisMode,
    decodePreference,
    persistHistory: historyEnabled,
    parallelPreference,
    recoveryWritesAllowed,
    restoreReady: true,
  });

  const completionAnnouncement = useCompletionAnnouncer(jobs);
  const {
    batchProgress,
    currentModeLabel,
    hottestTruePeak,
    queueAverage,
    queueCounts,
    queueShownLabel,
    queueViewIsFiltered,
    resolvedSelectedJobId,
    selectedJob,
    selectedJobHiddenByFilter,
    sessionStats,
    sessionTabCounts,
    sortedQueueJobs,
    sortedQueueJobsRef,
    targetingEnabled,
  } = useQueueView({
    activeTarget,
    activeWorkspaceTab,
    analysisMode,
    completedJobs,
    deferredSearchQuery,
    jobs,
    parallelLimit,
    queueFilter,
    queueSearchDraft,
    queueSort,
    selectedJobId,
  });
  // Two independent channels (UX-035): a persistent warning region holds
  // worker and storage/recovery failures with clear warning styling until they resolve,
  // while a separate transient polite region carries short-lived action
  // confirmations. Sharing one slot meant a persistent failure permanently
  // masked later feedback (and its announcement).
  const persistentWarning = workerCircuitIssue ?? persistenceIssue ?? settingsPersistenceIssue;
  const transientNotice = uiNotice ?? notice;
  const persistentAction = workerCircuitIssue
    ? { label: "Retry analysis", onClick: retryAnalysis }
    : persistenceIssue == null && settingsPersistenceIssue != null
      ? { label: "Try saving again", onClick: retrySettingsPersistence }
      : null;
  const showHomeSupportSection = jobs.length > 0 || historyEnabled || recentSessions.length > 0;
  const queueEmptyCopy = jobs.length
    ? {
        title: "No files match this view",
        body: "Reset the queue view to show the current session again, or add more files.",
        actionLabel: "Reset View",
      }
    : {
        title: "No files queued yet",
        body: "Add audio files to start a local loudness and true peak review.",
        actionLabel: "Add Files",
      };
  const simpleInlineInspector = activeWorkspaceTab === "queue" && uiMode === "simple" && isLargeScreen;
  // Advanced now shows the inspector inline only on large screens; below the
  // breakpoint it uses the drawer just like Simple (UX-014), so selecting an
  // early row no longer scrolls past the whole queue to a distant inline panel.
  const advancedInlineInspector = activeWorkspaceTab === "queue" && uiMode === "advanced" && isLargeScreen;
  const useInlineInspector = simpleInlineInspector || advancedInlineInspector;
  const showInlineInspector = !!selectedJob && useInlineInspector;
  const inspectorDrawerOpen =
    workspaceDrawer === "inspector" &&
    !!selectedJob &&
    activeWorkspaceTab === "queue" &&
    !useInlineInspector;

  const routeNormalizationOptions = useMemo(() => ({
    completedJobIds: new Set(completedJobs.map((job) => job.id)),
    historyEnabled,
    jobIds: new Set(jobs.map((job) => job.id)),
    resolvedSelectedJobId,
    restoreSettled,
    selectedJobAvailable: selectedJob != null,
    showInlineInspector,
  }), [
    completedJobs,
    historyEnabled,
    jobs,
    resolvedSelectedJobId,
    restoreSettled,
    selectedJob,
    showInlineInspector,
  ]);
  useNormalizeWorkspaceRoute(workspaceRoute, routeNormalizationOptions);

  const openSessionWorkspace = useCallback(() => {
    updateWorkspaceRoute({ screen: "session", tab: "queue" }, { history: "push" });
  }, [updateWorkspaceRoute]);
  const handleFilesAdded = useCallback(() => {
    updateWorkspaceRoute(
      { screen: "session", tab: "queue", drawer: null },
      { history: "push" },
    );
  }, [updateWorkspaceRoute]);
  const {
    handleFiles,
    handleSessionFile,
    inputRef,
    isDragging,
    openPicker,
    openSessionPicker,
    sessionInputRef,
  } = useFileIntake({
    enqueueFiles,
    importSession,
    onFilesAdded: handleFilesAdded,
    pushUiNotice,
  });

  // Rendered above the inspector (inline or drawer) whenever the explicitly
  // selected job still exists but the active queue filter/search hides it
  // from the visible list, so the inspector keeping that job's data on
  // screen (see selectedJob above) is never mistaken for a stale or broken
  // view. "Show in list" clears the filter/search/sort so the row reappears.
  const selectionHiddenNotice =
    selectedJobHiddenByFilter && selectedJob ? (
      <div
        role="status"
        className="tp-notice-in mb-4 flex items-start gap-3 rounded-[22px] border border-[color:var(--accent)]/15 bg-[color:var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <span>
            {"Hidden by the current search or filter. Still showing "}
            <strong className="font-semibold">{selectedJob.fileName}</strong>
            {"."}
          </span>
          <div className="mt-2">
            <Button type="button" size="sm" variant="secondary" onClick={resetQueueView}>
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
              Show in list
            </Button>
          </div>
        </div>
      </div>
    ) : null;

  const retrySingleJob = useCallback((jobId: string) => {
    retryJob(jobId);
  }, [retryJob]);

  const retryIssueJobs = () => {

    retryIssues();
  };

  // Deliberate open (click / Enter on a row / open-from-Compare). Pushes a
  // history entry (UX-013) and opens the inspector inline or as a drawer per
  // the current layout (UX-014). A deliberate open always reveals a row that
  // the current filter/search hides, so the inspector resolves to the intended
  // file instead of falling back to the first visible row.
  const selectJob = useCallback((jobId: string, options?: { scrollToInline?: boolean }) => {
    const isHidden = !sortedQueueJobsRef.current.some((job) => job.id === jobId);
    if (isHidden) {
      setQueueSearchDraft("");
    }

    if (options?.scrollToInline && !isHidden) {
      pendingInspectorFocusRef.current = true;
      setInspectorFocusRequest((current) => current + 1);
    }

    const updates: Record<string, string | null> = {
      screen: "session",
      tab: "queue",
      job: jobId,
      detail: detailTab || "overview",
      drawer: useInlineInspector ? null : "inspector",
    };

    if (isHidden) {
      updates.filter = null;
      updates.search = null;
    }

    updateWorkspaceRoute(updates, { history: "push" });
  }, [detailTab, setQueueSearchDraft, sortedQueueJobsRef, useInlineInspector, updateWorkspaceRoute]);

  const chooseJob = useCallback((jobId: string) => {
    // Only the advanced inline layout needs the programmatic scroll/focus to the
    // detail panel below the queue; the drawer traps focus on its own.
    selectJob(jobId, { scrollToInline: advancedInlineInspector });
  }, [advancedInlineInspector, selectJob]);

  // Arrow-key roving navigation: move selection AND DOM focus together so focus
  // never diverges from the highlighted row, and Enter always acts on the row
  // the user is on (UX-024). Uses "replace" (refinement, not a structural
  // transition) and never opens the drawer - only a deliberate open does that.
  const highlightJob = useCallback((jobId: string) => {
    pendingQueueFocusRef.current = jobId;
    setQueueFocusTick((current) => current + 1);
    updateWorkspaceRoute({ screen: "session", tab: "queue", job: jobId }, { history: "replace" });
  }, [updateWorkspaceRoute]);

  const handleQueueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shouldIgnoreQueueNavigationTarget(event.target)) return;
    if (!sortedQueueJobs.length) return;
    // Anchor movement to the actually-focused row when there is one, so arrows
    // step from where the user is rather than a stale selection. Enter/Space is
    // intentionally left to the focused row's own button (it doubles as
    // Inspect), which avoids a double activation.
    const focusedId =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-queue-nav="true"]')?.dataset.jobId
        : undefined;
    const anchorId = focusedId ?? selectedJob?.id;
    const currentIndex = sortedQueueJobs.findIndex((job) => job.id === anchorId);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = sortedQueueJobs[currentIndex < 0 ? 0 : Math.min(currentIndex + 1, sortedQueueJobs.length - 1)];
      if (next) highlightJob(next.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = sortedQueueJobs[currentIndex < 0 ? sortedQueueJobs.length - 1 : Math.max(currentIndex - 1, 0)];
      if (previous) highlightJob(previous.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      highlightJob(sortedQueueJobs[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      highlightJob(sortedQueueJobs[sortedQueueJobs.length - 1].id);
    }
  };

  const handleWorkspaceTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const lastIndex = SESSION_TABS.length - 1;
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = index >= lastIndex ? 0 : index + 1;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = index <= 0 ? lastIndex : index - 1;
    }

    if (event.key === "Home") {
      nextIndex = 0;
    }

    if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex == null) {
      return;
    }

    event.preventDefault();
    workspaceTabRefs.current[nextIndex]?.focus();
    setWorkspaceTab(SESSION_TABS[nextIndex].id, { history: "replace" });
  };

  useEffect(() => {
    if (!pendingInspectorFocusRef.current || !advancedInlineInspector || !selectedJob) {
      return;
    }

    pendingInspectorFocusRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      advancedInspectorSectionRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      advancedInspectorHeadingRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [advancedInlineInspector, inspectorFocusRequest, selectedJob]);

  // Move DOM focus onto the highlighted row's primary control after arrow-key
  // navigation so focus follows selection and the newly focused, labeled
  // control ("Inspect <file>") is announced (UX-024). Runs after the commit so
  // the row exists; picks the visible presentation (mobile card vs desktop row)
  // via offsetParent, since both are mounted and only CSS-hidden.
  useEffect(() => {
    const jobId = pendingQueueFocusRef.current;
    if (!jobId) {
      return;
    }
    const region = queueRegionRef.current;
    if (!region) {
      return;
    }
    const target = Array.from(
      region.querySelectorAll<HTMLElement>('[data-queue-nav="true"]'),
    ).find((element) => element.dataset.jobId === jobId && element.offsetParent !== null);
    if (target) {
      pendingQueueFocusRef.current = null;
      target.focus();
    }
  }, [queueFocusTick]);

  const {
    closeConfirmDialog,
    confirmDialogCopy,
    confirmDialogState,
    requestClearFinished,
    requestClearHistory,
    requestClearSession,
    requestClosePresetDrawer,
    requestRemoveJob,
    runConfirmedAction,
  } = useConfirmDialog({
    clearFinished,
    clearRecentSessions,
    clearSession,
    handleCancelDraft,
    pushUiNotice,
    removeJob,
    setWorkspaceDrawer,
    workspaceDrawer,
  });

  const goHome = useCallback(() => setWorkspaceScreen("home"), [setWorkspaceScreen]);
  const openCompare = useCallback(() => setWorkspaceTab("compare"), [setWorkspaceTab]);
  const openHistory = useCallback(() => setWorkspaceDrawer("history"), [setWorkspaceDrawer]);
  const openPresetLibrary = useCallback(() => setWorkspaceDrawer("presets"), [setWorkspaceDrawer]);
  const commandContextValue = useMemo<WorkspaceCommandContextValue>(() => ({
    cancelActiveJobs,
    cancelJob,
    clearSession,
    currentModeLabel,
    currentTarget: targetingEnabled ? activeTarget : null,
    compatibilityDecoderAllowed,
    connectionSavingStatus,
    decodeLabel: formatDecodePreferenceLabel(decodePreference),
    decodePreference,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportSession,
    goHome,
    historyEnabled,
    isDragging,
    openCompare,
    openHistory,
    openPicker,
    openPresetLibrary,
    openSessionPicker,
    parallelPreference,
    requestClearFinished,
    requestClearSession,
    retryJob: retrySingleJob,
    route: { analysisMode, detailTab, uiMode },
    setAnalysisMode,
    setCompatibilityDecoderAllowed: setCompatibilityDecoderOptIn,
    setDecodePreference,
    setDetailTab,
    setParallelPreference,
    setUiMode,
    toggleHistory: toggleHistoryEnabled,
    toggleTheme,
  }), [
    activeTarget,
    analysisMode,
    cancelActiveJobs,
    cancelJob,
    clearSession,
    currentModeLabel,
    compatibilityDecoderAllowed,
    connectionSavingStatus,
    decodePreference,
    detailTab,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportSession,
    goHome,
    historyEnabled,
    isDragging,
    openCompare,
    openHistory,
    openPicker,
    openPresetLibrary,
    openSessionPicker,
    parallelPreference,
    requestClearFinished,
    requestClearSession,
    retrySingleJob,
    setAnalysisMode,
    setDecodePreference,
    setDetailTab,
    setParallelPreference,
    setUiMode,
    targetingEnabled,
    toggleHistoryEnabled,
    toggleTheme,
    uiMode,
  ]);
  const sessionContextValue = useMemo<WorkspaceSessionContextValue>(() => ({
    batchProgress,
    completedJobs,
    jobs,
    parallelLimit,
    queueCounts,
    selectedJob,
    sessionStats,
  }), [
    batchProgress,
    completedJobs,
    jobs,
    parallelLimit,
    queueCounts,
    selectedJob,
    sessionStats,
  ]);
  const inspectorPanel = selectedJob ? (
    <InspectorPanel
      headingId={advancedInlineInspector ? "selected-file-details-heading" : undefined}
      headingRef={advancedInlineInspector ? advancedInspectorHeadingRef : undefined}
      headingTabIndex={advancedInlineInspector ? -1 : undefined}
    />
  ) : null;
  const inspectorSlot = selectedJob ? (
    <>
      {selectionHiddenNotice}
      {inspectorPanel}
    </>
  ) : null;

  const sessionOverviewCards = (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricTile label="Queued now" value={numberFormatter.format(jobs.length)} hint={jobs.length ? "Files already in the current session" : "No files queued yet"} accent={jobs.length > 0} />
      <MetricTile label="Completed" value={numberFormatter.format(completedJobs.length)} hint="Results ready to inspect or export" />
      <MetricTile label="Average LUFS" value={formatLufs(queueAverage)} hint={completedJobs.length ? "Average across valid integrated readings" : "Waiting for finished analyses"} />
      <MetricTile label="Hottest true peak" value={formatPeakDbtp(hottestTruePeak)} hint={completedJobs.length ? "Highest measured peak so far" : "Waiting for finished analyses"} />
    </div>
  );

  return (
    <WorkspaceCommandProvider value={commandContextValue}>
      <WorkspaceSessionProvider value={sessionContextValue}>
      <>
      <ThemeSynchronizer />
      <a href="#truepeak-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-[var(--surface-1)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--ink)] focus:shadow-[var(--shadow-elevated)]">
        Skip to main content
      </a>
      <main
        ref={mainRef}
        id="truepeak-main"
        data-hydrated="false"
        className="tp-min-h-viewport mx-auto flex w-full max-w-[1760px] flex-col gap-6 px-4 py-6 sm:px-6 xl:px-8 2xl:px-10"
      >
      {/* Hidden polite region announcing batch completions and failures. Kept a
          direct-child live region on purpose: the modal inert-walk in
          use-modal-focus.ts exempts sibling live regions element-by-element, so
          wrapping this in a non-live container would silence it behind an open
          drawer or dialog. */}
      <div role="status" aria-live="polite" className="sr-only">
        {completionAnnouncement}
      </div>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept="audio/*,.wav,.rf64,.aif,.aiff,.aifc,.mp3,.m4a,.aac,.flac,.ogg,.opus"
        onChange={(event) => handleFiles(event.target.files)}
      />
      <input
        ref={sessionInputRef}
        type="file"
        hidden
        accept=".json,.truepeak.json,application/json"
        onChange={(event) => handleSessionFile(event.target.files)}
      />

      {workspaceScreen === "home" ? (
        <>
          <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--accent)]/18 bg-[color:var(--accent-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-text)]">
                <Waves className="h-3.5 w-3.5" />
                In-browser loudness analysis
              </div>
              <h1 className="mt-4"><TruePeakLogo size="lg" subtitle="Loudness and true peak review" titleClassName="leading-none" /></h1>
              <p className="mt-3 max-w-[60rem] text-sm leading-6 text-[var(--muted)] sm:text-base">
                Load a batch, measure LUFS and true peak, and review delivery targets without sending files anywhere. Use it as a review aid, not a certified compliance meter.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ThemeToggle onToggle={toggleTheme} />
              <Button type="button" size="sm" variant="secondary" onClick={openSessionPicker}>
                <FolderOpen className="h-4 w-4" />
                Open Session
              </Button>
              {jobs.length ? (
                <Button type="button" size="sm" variant="secondary" onClick={openSessionWorkspace}>
                  <BarChart3 className="h-4 w-4" />
                  Resume Session ({jobs.length})
                </Button>
              ) : null}
            </div>
          </header>

          {/* Notice regions stay mounted even when empty: live regions inserted
              together with their content are skipped by several screen readers,
              so only the message inside may come and go. */}
          <WorkspaceNotices
            persistentWarning={persistentWarning}
            transientNotice={transientNotice}
            persistentAction={persistentAction}
          />

          <HomeStage
            supportedFormats={SUPPORTED_FORMATS}
            decodeOptions={DECODE_PREFERENCES}
          />

          {showHomeSupportSection ? (
          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)] xl:items-stretch">
            <Card className="h-full min-h-[548px] p-5 sm:p-6">
              <div className="flex h-full flex-col">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Session snapshot</div>
                    <h2 className="mt-2 text-balance text-2xl font-semibold text-[var(--ink)]">Where the current run stands</h2>
                    <p className="mt-2 max-w-[56rem] text-sm leading-6 text-[var(--muted)]">
                      Your queue and finished results stay put as you move between the home screen, the simple table, and the advanced tools.
                    </p>
                  </div>
                  {jobs.length ? (
                    <Button type="button" size="sm" variant="secondary" onClick={openSessionWorkspace}>
                      <BarChart3 className="h-4 w-4" />
                      Open Results
                    </Button>
                  ) : null}
                </div>
                <div className="mt-5">{sessionOverviewCards}</div>
                <div className="mt-5 grid flex-1 gap-3 lg:grid-cols-2">
                  <div className="flex h-full min-h-[176px] flex-col rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] px-5 py-5">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Current workflow</div>
                    <div className="mt-3 text-base font-semibold text-[var(--ink)]">{uiMode === "simple" ? "Simple view is ready" : "Advanced view is ready"}</div>
                    <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                      {uiMode === "simple"
                        ? "Simple keeps the table in front, with file details following from the list."
                        : "Advanced keeps compare, insights, and deeper controls together in one place."}
                    </p>
                  </div>
                  <div className="flex h-full min-h-[176px] flex-col rounded-[24px] border border-[var(--line)]/80 bg-[var(--surface-1)] px-5 py-5">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Supported formats</div>
                    <div className="mt-3 text-base font-semibold text-[var(--ink)]">{SUPPORTED_FORMATS.join(", ")}</div>
                    <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
                      Set the decode path up front, then the review stays on the results.
                    </p>
                  </div>
                </div>
              </div>
            </Card>

            <div className="grid gap-6">
              <HistoryPreferenceCard
                className="min-h-[260px]"
                historyEnabled={historyEnabled}
                recentCount={recentSessions.length}
                onToggle={toggleHistoryEnabled}
                onClear={requestClearHistory}
              />
              {historyEnabled ? (
                <RecentSessionsPanel className="min-h-[260px]" recentSessions={recentSessions} compact onClear={requestClearHistory} />
              ) : (
                <Card className="h-full min-h-[260px] p-5 sm:p-6">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Workflow notes</div>
                  <h2 className="mt-2 text-2xl font-semibold text-[var(--ink)]">How the defaults are set</h2>
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className="flex h-full min-h-[160px] flex-col rounded-[22px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-4">
                      <div className="text-sm font-semibold text-[var(--ink)]">Simple starts first</div>
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        Start in the table view, then switch to Advanced only when you want compare, insights, or deeper preset control.
                      </p>
                    </div>
                    <div className="flex h-full min-h-[160px] flex-col rounded-[22px] border border-[var(--line)]/80 bg-[var(--surface-1)] p-4">
                      <div className="text-sm font-semibold text-[var(--ink)]">History is optional</div>
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        Completed runs use local recovery storage until you clear the session. Recent History is an optional, separate summary list.
                      </p>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          </section>
          ) : null}
        </>
      ) : (
        <>
          <h1 className="sr-only">Review session</h1>
          {isDragging ? (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-[color:var(--surface-0)]/72 p-6 backdrop-blur-[2px]"
            >
              <div className="rounded-[26px] border-2 border-dashed border-[var(--accent)] bg-[var(--surface-1)] px-8 py-6 text-center shadow-[var(--shadow-elevated)]">
                <div className="text-lg font-semibold text-[var(--ink)]">Drop audio files to add them</div>
                <div className="mt-1 text-sm text-[var(--muted)]">They join the current session queue. Folders are scanned for audio.</div>
              </div>
            </div>
          ) : null}
          <StudioToolbar />

          <WorkspaceNotices
            persistentWarning={persistentWarning}
            transientNotice={transientNotice}
            persistentAction={persistentAction}
          />

          <WorkspaceSummaryRail
            variant={uiMode === "advanced" ? "compact" : "default"}
          />

          {uiMode === "advanced" ? (
            <div className="rounded-[20px] border border-[var(--line)]/70 bg-[var(--surface-1)]/72 p-1.5">
              {/* Full-width three-item segmented row: equal thirds fit on one
                  line at every width instead of wrapping Queue/Compare onto one
                  row and Insights onto another (UX-036). The icon drops below
                  sm and the label truncates so the segments never overflow on a
                  narrow phone. */}
              <div className="grid grid-cols-3 gap-1.5" role="tablist" aria-label="Session views">
                {SESSION_TABS.map((tab, index) => {
                  const Icon = tab.icon;
                  const selected = workspaceTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      ref={(element) => {
                        workspaceTabRefs.current[index] = element;
                      }}
                      type="button"
                      role="tab"
                      id={`workspace-tab-${tab.id}`}
                      aria-selected={selected}
                      aria-controls={selected ? `workspace-panel-${tab.id}` : undefined}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setWorkspaceTab(tab.id)}
                      onKeyDown={(event) => handleWorkspaceTabKeyDown(event, index)}
                      className={cn(
                        "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-[16px] border px-2 py-2.5 text-sm font-semibold transition-[background-color,border-color,color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                        selected
                          ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[var(--ink)]"
                          : "border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)] hover:border-[color:var(--accent)]/35 hover:text-[var(--ink)]",
                      )}
                    >
                      <Icon className="hidden h-4 w-4 shrink-0 sm:inline" aria-hidden="true" />
                      <span className="truncate">{tab.label}</span>
                      <span className="shrink-0 rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--muted)]">
                        {sessionTabCounts[tab.id]}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {activeWorkspaceTab === "queue" ? (
            <section id="workspace-panel-queue" role={uiMode === "advanced" ? "tabpanel" : undefined} aria-labelledby={uiMode === "advanced" ? "workspace-tab-queue" : undefined} className="space-y-6">
              <div className={cn("min-w-0", uiMode === "advanced" ? "space-y-4" : "space-y-6")}>
                <Card className={cn(uiMode === "advanced" ? "p-4 sm:p-5" : "p-5 sm:p-6")}>
                  <div className={cn("flex flex-col gap-4", uiMode === "advanced" ? "lg:flex-row lg:items-center lg:justify-between" : "xl:flex-row xl:items-end xl:justify-between")}>
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                        {uiMode === "simple" ? "Results table" : "Queue"}
                      </div>
                      <h2 className={cn("mt-2 text-balance font-semibold text-[var(--ink)]", uiMode === "advanced" ? "text-xl" : "text-2xl")}>
                        {uiMode === "simple"
                          ? "Scan the batch first, then open the files that need attention"
                          : "Review the batch, then inspect the selected file below"}
                      </h2>
                      {uiMode === "advanced" ? (
                        <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--muted)]">
                          Select a row to update the detail section below while filters, sort, and progress stay compact.
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="secondary" onClick={retryIssueJobs} disabled={!queueCounts.issues}>
                        <RefreshCcw className="h-4 w-4" />
                        Retry Issues
                      </Button>
                      <Button type="button" size="sm" variant="secondary" onClick={openPicker}>
                        <Plus className="h-4 w-4" />
                        Add Files
                      </Button>
                    </div>
                  </div>

                  {/* Only the "N of M shown" chip lives here now. The per-status
                      counts (active / complete / issues) were duplicated by the
                      filter buttons directly below and by the summary rail, so
                      the status chips were removed to give each count one
                      canonical home (UX-010 / UX-036). */}
                  <div className={cn("flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]", uiMode === "advanced" ? "mt-4" : "mt-5")}>
                    <span className="rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-3 py-1.5">{queueShownLabel}</span>
                  </div>

                  <div className={cn("grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end", uiMode === "advanced" ? "mt-4" : "mt-5")}>
                    <div className="relative w-full">
                      <label htmlFor="queue-search" className="sr-only">
                        Search the current queue
                      </label>
                      <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]" />
                      <input
                        id="queue-search"
                        name="queue-search"
                        type="search"
                        value={queueSearchDraft}
                        onChange={(event) => setQueueSearchDraft(event.target.value)}
                        aria-label="Search files in the current session"
                        aria-keyshortcuts="/"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Search by file, status, preset, decoder, or layout…"
                        className={cn("w-full rounded-full border border-[var(--control-line)] bg-[var(--surface-1)] pl-11 pr-4 text-sm text-[var(--ink)] outline-none transition-[border-color,background-color] duration-200 ease-out focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]", uiMode === "advanced" ? "h-10" : "h-11")}
                      />
                    </div>
                    <div className="flex flex-col gap-3 xl:items-end">
                      <div role="group" aria-label="Filter queue items" className="flex flex-wrap items-center gap-2">
                        {QUEUE_FILTERS.map((filter) => (
                          <button
                            key={filter.id}
                            type="button"
                            aria-pressed={queueFilter === filter.id}
                            onClick={() => setQueueFilter(filter.id)}
                            className={cn(
                              "rounded-full border px-3 text-xs font-semibold uppercase tracking-[0.16em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                              uiMode === "advanced" ? "py-1.5" : "py-2",
                              queueFilter === filter.id
                                ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[var(--ink)]"
                                : "border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)] hover:border-[color:var(--accent)]/30",
                            )}
                          >
                            {filter.label} ({queueCounts[filter.id]})
                          </button>
                        ))}
                      </div>
                      <label htmlFor="queue-sort" className={cn("inline-flex items-center gap-2 rounded-full border border-[var(--control-line)] bg-[var(--surface-1)] px-4 text-sm text-[var(--muted)]", uiMode === "advanced" ? "py-1.5" : "py-2")}>
                        <ArrowUpDown className="h-4 w-4" />
                        <span>Sort:</span>
                        <select id="queue-sort" name="queue-sort" aria-label="Sort files in the current session" value={queueSort} onChange={(event) => setQueueSort(event.target.value as QueueSort)} className="rounded-[8px] bg-transparent font-semibold text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                          {QUEUE_SORTS.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      {queueViewIsFiltered ? (
                        <Button type="button" size="sm" variant="ghost" onClick={resetQueueView} aria-label="Reset View: clears queue search, filters, and sort">
                          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                          Reset View
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <p className={cn("text-xs leading-5 text-[var(--muted)]", uiMode === "advanced" ? "mt-4" : "mt-5")}>
                    Keyboard: arrows move, Enter opens, / searches.
                  </p>

                  <div
                    ref={queueRegionRef}
                    role="region"
                    aria-label="File queue"
                    aria-keyshortcuts="ArrowUp ArrowDown Home End Enter"
                    className="mt-2 space-y-4"
                    onKeyDown={handleQueueKeyDown}
                  >
                    {sortedQueueJobs.length ? (
                      uiMode === "simple" ? (
                        <SimpleResultsTable
                          analysisMode={analysisMode}
                          jobs={sortedQueueJobs}
                          selectedJobId={selectedJob?.id ?? null}
                          onCancelJob={cancelJob}
                          onOpenJob={chooseJob}
                          onRemoveJob={requestRemoveJob}
                          onRetryJob={retrySingleJob}
                        />
                      ) : (
                        <div className="grid gap-2">
                          {sortedQueueJobs.map((job) => (
                            <AdvancedQueueRow
                              key={job.id}
                              job={job}
                              selected={job.id === selectedJob?.id}
                              analysisMode={analysisMode}
                              onCancelJob={cancelJob}
                              onOpenJob={chooseJob}
                              onRemoveJob={requestRemoveJob}
                              onRetryJob={retrySingleJob}
                            />
                          ))}
                        </div>
                      )
                    ) : (
                      <EmptyState
                        title={queueEmptyCopy.title}
                        body={queueEmptyCopy.body}
                        icon={AudioLines}
                        actionLabel={queueEmptyCopy.actionLabel}
                        onAction={jobs.length ? resetQueueView : openPicker}
                      />
                    )}
                  </div>
                </Card>

                {uiMode === "simple" && showInlineInspector && selectedJob ? (
                  <div className="min-w-0">
                    {inspectorSlot}
                  </div>
                ) : null}

                {uiMode === "advanced" && showInlineInspector && selectedJob ? (
                  <section
                    ref={advancedInspectorSectionRef}
                    id="selected-file-details"
                    aria-labelledby="selected-file-details-heading"
                    // No scroll-mt here: html carries scroll-padding-top sized
                    // from the toolbar's measured height, and scroll-padding on
                    // the scroll root and scroll-margin on the target both apply,
                    // which would push this section down by roughly twice the
                    // bar's height on every Inspect click.
                    className="min-w-0 focus:outline-none"
                  >
                  {inspectorSlot}
                  </section>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeWorkspaceTab === "compare" ? (
            <section
              id="workspace-panel-compare"
              role="tabpanel"
              aria-labelledby="workspace-tab-compare"
              className="min-w-0"
            >
              <CompareStudio
                sessionStats={sessionStats}
                currentTarget={analysisMode === "targeted" ? activeTarget : null}
                analysisMode={analysisMode}
                selectedJobId={selectedJob?.id ?? null}
                referenceId={referenceId}
                compareView={compareView}
                compareSort={compareSort}
                compareDirection={compareDirection}
                compareFilter={compareFilter}
                onReferenceIdChange={setReferenceId}
                onCompareViewChange={setCompareView}
                onCompareSortChange={setCompareSort}
                onCompareFilterChange={setCompareFilter}
                onOpenQueue={() => setWorkspaceTab("queue")}
                onOpenJob={chooseJob}
              />
            </section>
          ) : null}

          {activeWorkspaceTab === "insights" ? (
            <section
              id="workspace-panel-insights"
              role="tabpanel"
              aria-labelledby="workspace-tab-insights"
              className="min-w-0"
            >
              <SessionInsightsPanel
                sessionStats={sessionStats}
                currentTarget={analysisMode === "targeted" ? activeTarget : null}
                analysisMode={analysisMode}
                historyEnabled={historyEnabled}
                recentSessionCount={recentSessions.length}
                onOpenCompare={() => setWorkspaceTab("compare")}
                onOpenQueue={() => setWorkspaceTab("queue")}
                onOpenJob={chooseJob}
              />
            </section>
          ) : null}
        </>
      )}

      {confirmDialogCopy ? (
        <ConfirmDialog
          open={!!confirmDialogState}
          title={confirmDialogCopy.title}
          description={confirmDialogCopy.description}
          confirmLabel={confirmDialogCopy.confirmLabel}
          onClose={closeConfirmDialog}
          onConfirm={runConfirmedAction}
        />
      ) : null}

      <PresetLibraryDrawer
        open={workspaceDrawer === "presets" && targetingEnabled}
        onClose={() => {
          // Escape, backdrop click, and the Close button all route through
          // here (browser Back does not - see WP-17 notes). A dirty draft
          // asks first instead of silently discarding it (UX-09).
          if (draftIsDirty) {
            requestClosePresetDrawer();
            return;
          }
          setWorkspaceDrawer("none");
        }}
        activeTarget={activeTarget}
        draftTarget={draftPreviewTarget}
        fieldErrors={draftResolution.errors}
        draftStatusMessage={draftStatus}
        draftIsValid={draftResolution.isValid}
        draftIsDirty={draftIsDirty}
        draftIsModified={draftIsModified}
        selectedPresetId={targetState.draft.presetId}
        toleranceLufs={targetState.draft.toleranceLufs}
        customTargetLufs={targetState.draft.customTargetLufs}
        customTruePeak={targetState.draft.customTruePeak}
        policy={targetState.draft.policy}
        onSelectPreset={handleSelectPreset}
        onToleranceChange={handleToleranceChange}
        onCustomTargetLufsChange={handleCustomTargetLufsChange}
        onCustomTruePeakChange={handleCustomTruePeakChange}
        onPolicyChange={handlePolicyChange}
        onApply={handleApplyDraft}
        onCancel={handleCancelDraft}
        onResetToPublished={handleResetToPublished}
      />

      <DrawerPanel
        open={workspaceDrawer === "history" && historyEnabled}
        onClose={() => setWorkspaceDrawer("none")}
        title="Saved History"
        description="Completed analyses stored locally in this browser. Turn history on only when you want quick recall between sessions."
        mobileMode="full"
        desktopClassName="lg:w-[min(760px,96vw)]"
      >
        <RecentSessionsPanel recentSessions={recentSessions} onClear={requestClearHistory} />
      </DrawerPanel>

      <DrawerPanel
        open={inspectorDrawerOpen}
        onClose={() => setWorkspaceDrawer("none")}
        title={selectedJob ? selectedJob.fileName : "File details"}
        description="Review loudness, timeline, and technical details without leaving the current list."
        mobileMode="sheet"
        desktopClassName="lg:w-[min(760px,96vw)]"
      >
        {inspectorSlot}
      </DrawerPanel>
      </main>
      </>
      </WorkspaceSessionProvider>
    </WorkspaceCommandProvider>
  );
}

































































