"use client";

import {
  startTransition,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpDown,
  AudioLines,
  BarChart3,
  FolderOpen,
  Gauge,
  Info,
  Moon,
  Plus,
  RefreshCcw,
  Search,
  Square,
  Sun,
  Trash2,
  Waves,
} from "lucide-react";
import { getComplianceSummary } from "@/audio/compliance";
import { DEFAULT_TARGET_PRESET, TARGET_PRESETS } from "@/audio/presets";
import { MAX_DROPPED_FILES, collectDroppedFiles } from "@/lib/dropped-files";
import { HistoryPreferenceCard, RecentSessionsPanel } from "@/components/history-panels";
import { useTruePeakAnalyzer } from "@/hooks/use-truepeak-analyzer";
import {
  formatDuration,
  formatLufs,
  formatPeakDbtp,
  formatRelativeDb,
} from "@/lib/format";
import { getJobErrorDisplay } from "@/lib/job-ui";
import { complianceToneClass, statusToneClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import type {
  AnalysisJob,
  AnalysisMode,
  DecodePreference,
  TargetPreset,
} from "@/types/audio";
import { CompareStudio, type CompareFilter, type CompareSort, type CompareView, type SortDirection } from "@/components/compare-studio";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DrawerPanel } from "@/components/drawer-panel";
import { HomeStage } from "@/components/home-stage";
import { InspectorPanel } from "@/components/inspector-panel";
import { PresetLibraryDrawer, type TargetFieldErrors } from "@/components/preset-library-drawer";
import { SessionInsightsPanel } from "@/components/session-insights";
import { SimpleResultsTable } from "@/components/simple-results-table";
import { StudioToolbar } from "@/components/studio-toolbar";
import { TruePeakLogo } from "@/components/truepeak-logo";
import {
  averageIntegratedLufs,
  countQueueJobs,
  getComplianceCounts,
  highestTruePeakDbtp,
  isActiveJob,
  isIssueJob,
} from "@/lib/session-selectors";
import {
  readHistoryPreference,
  readParallelPreference,
  readThemePreference,
  readUiModePreference,
  subscribeHistoryPreference,
  subscribeParallelPreference,
  subscribeThemePreference,
  subscribeUiModePreference,
  type ParallelLanesPreference,
  type WorkspaceTheme,
  type WorkspaceUiMode,
  writeHistoryPreference,
  writeParallelPreference,
  writeThemePreference,
  writeUiModePreference,
} from "@/lib/workspace-preferences";
import { WorkspaceSummaryRail } from "@/components/workspace-summary-rail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const CUSTOM_ID = "custom";
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
const queueCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
type UiMode = WorkspaceUiMode;
type WorkspaceScreen = "home" | "session";
type WorkspaceTab = "queue" | "compare" | "insights";
type WorkspaceDrawer = "none" | "presets" | "inspector" | "history";
type QueueFilter = "all" | "active" | "complete" | "issues";
type QueueSort = "recent" | "oldest" | "status" | "integrated" | "truePeak" | "name";
type DetailTab = "overview" | "timeline" | "metadata";
type ConfirmDialogState =
  | { type: "remove-job"; jobId: string }
  | { type: "clear-finished" }
  | { type: "clear-session" }
  | { type: "clear-history" }
  | null;

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
const DETAIL_TABS: Array<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "metadata", label: "Technical" },
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
      "Uses the stricter parser for PCM containers and chooses the quickest reliable path for compressed sources.",
  },
  {
    id: "browser-first",
    label: "Browser first",
    description:
      "Best everyday option for MP3, AAC, FLAC, and Opus. Falls back to compatibility decoding only when needed.",
  },
  {
    id: "compatibility-first",
    label: "Compatibility first",
    description:
      "Push compressed files through the compatibility decoder first. Slower, but useful when browser codecs are inconsistent.",
  },
];

function queueStatusRank(status: AnalysisJob["status"]) {
  switch (status) {
    case "analyzing":
      return 0;
    case "decoding":
      return 1;
    case "reading":
      return 2;
    case "queued":
      return 3;
    case "complete":
      return 4;
    case "failed":
      return 5;
    case "canceled":
    default:
      return 6;
  }
}

function sortQueueJobs(left: AnalysisJob, right: AnalysisJob, queueSort: QueueSort) {
  switch (queueSort) {
    case "oldest":
      return left.createdAt.localeCompare(right.createdAt);
    case "status": {
      const statusDelta = queueStatusRank(left.status) - queueStatusRank(right.status);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      return right.createdAt.localeCompare(left.createdAt);
    }
    case "integrated": {
      const leftValue = left.result?.metrics.integratedLufs;
      const rightValue = right.result?.metrics.integratedLufs;
      if (leftValue == null && rightValue == null) {
        return right.createdAt.localeCompare(left.createdAt);
      }
      if (leftValue == null) {
        return 1;
      }
      if (rightValue == null) {
        return -1;
      }
      return rightValue - leftValue;
    }
    case "truePeak": {
      const leftValue = left.result?.metrics.truePeakDbtp;
      const rightValue = right.result?.metrics.truePeakDbtp;
      if (leftValue == null && rightValue == null) {
        return right.createdAt.localeCompare(left.createdAt);
      }
      if (leftValue == null) {
        return 1;
      }
      if (rightValue == null) {
        return -1;
      }
      return rightValue - leftValue;
    }
    case "name":
      return queueCollator.compare(left.fileName, right.fileName);
    case "recent":
    default:
      return right.createdAt.localeCompare(left.createdAt);
  }
}

function parseTargetNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

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

function MetricTile({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[148px] flex-col justify-between rounded-[24px] border p-5",
        accent
          ? "border-[color:var(--accent)]/25 bg-[color:var(--accent-soft)]"
          : "border-[var(--line)] bg-[var(--surface-1)]",
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
        {label}
      </div>
      <div className="mt-3 space-y-2">
        <div className="text-[clamp(1.7rem,2vw,2.35rem)] font-semibold leading-tight text-[var(--ink)] break-words">
          {value}
        </div>
        {hint ? <div className="max-w-[30ch] text-xs leading-5 text-[var(--muted)]">{hint}</div> : null}
      </div>
    </div>
  );
}
function EmptyState({
  title,
  body,
  icon: Icon,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  icon: typeof Waves;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Card className="p-8 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[22px] border border-[var(--line)] bg-[var(--surface-1)] text-[var(--muted)]">
        <Icon className="h-7 w-7" aria-hidden="true" />
      </div>
      <h2 className="mt-5 text-2xl font-semibold text-[var(--ink)]">{title}</h2>
      <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{body}</p>
      {actionLabel && onAction ? (
        <Button type="button" size="sm" variant="secondary" onClick={onAction} className="mt-5">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {actionLabel}
        </Button>
      ) : null}
    </Card>
  );
}

function AdvancedQueueMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-[14px] border border-[var(--line)]/60 bg-[var(--surface-0)]/46 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold leading-tight tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: WorkspaceTheme; onToggle: () => void }) {
  const nextLabel = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={onToggle}
      aria-label={nextLabel}
      title={nextLabel}
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">{theme === "dark" ? "Light" : "Dark"}</span>
    </Button>
  );
}

const AdvancedQueueRow = memo(function AdvancedQueueRow({
  job,
  selected,
  analysisMode,
  onCancelJob,
  onOpenJob,
  onRemoveJob,
  onRetryJob,
}: {
  job: AnalysisJob;
  selected: boolean;
  analysisMode: AnalysisMode;
  onCancelJob: (jobId: string) => void;
  onOpenJob: (jobId: string) => void;
  onRemoveJob: (jobId: string) => void;
  onRetryJob: (jobId: string) => void;
}) {
  const compliance = job.result ? getComplianceSummary(job.result) : null;
  const errorDisplay = getJobErrorDisplay(job.error);
  const active = isActiveJob(job);

  return (
    <article
      className={cn(
        "tp-selected-row rounded-[18px] border overflow-hidden [content-visibility:auto] [contain-intrinsic-size:96px]",
        selected
          ? "border-[color:var(--accent)]/36 bg-[color:var(--accent-soft)] shadow-[0_14px_34px_rgba(0,0,0,0.12)]"
          : "border-[var(--line)]/72 bg-[var(--surface-0)]/48 hover:border-[color:var(--accent)]/24 hover:bg-[var(--surface-1)]/64",
      )}
      data-selected={selected}
      aria-current={selected ? "true" : undefined}
    >
      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)_auto] lg:items-center">
        <button
          type="button"
          data-queue-nav="true"
          onClick={() => onOpenJob(job.id)}
          className="min-w-0 rounded-[14px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          aria-label={`Inspect ${job.fileName}`}
        >
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                "mt-1 h-9 w-1.5 shrink-0 rounded-full",
                selected ? "bg-[var(--accent)]" : active ? "bg-[var(--warning)]" : "bg-[var(--line)]",
              )}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="break-words text-sm font-semibold leading-6 text-[var(--ink)]">
                {job.fileName}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge className={statusToneClass(job.status)}>{job.status}</Badge>
                {compliance ? <Badge className={complianceToneClass(compliance.state)}>{compliance.label}</Badge> : null}
                {job.result?.target ? <Badge>{job.result.target.label}</Badge> : null}
                {!compliance && job.result ? <Badge>Measure Only</Badge> : null}
                {job.result?.metadata.decoderLabel ? (
                  <Badge className="max-w-full break-words border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)]">
                    {job.result.metadata.decoderLabel}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
        </button>

        <div className={cn("grid min-w-0 gap-2", analysisMode === "targeted" ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3")}>
          <AdvancedQueueMetric label="Integrated" value={job.result ? formatLufs(job.result.metrics.integratedLufs) : "Waiting"} />
          <AdvancedQueueMetric label="True peak" value={job.result ? formatPeakDbtp(job.result.metrics.truePeakDbtp) : "n/a"} />
          {analysisMode === "targeted" ? (
            <AdvancedQueueMetric label="Gain" value={job.result ? formatRelativeDb(job.result.metrics.targetDeltaDb) : "n/a"} />
          ) : null}
          <AdvancedQueueMetric label="Duration" value={job.result ? formatDuration(job.result.metadata.durationSeconds) : "n/a"} />
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5 lg:justify-end">
          <Button type="button" size="sm" variant={selected ? "primary" : "secondary"} onClick={() => onOpenJob(job.id)} aria-label={`Inspect ${job.fileName}`}>
            Inspect
          </Button>
          {job.status === "failed" || job.status === "canceled" ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => onRetryJob(job.id)} aria-label={`Retry ${job.fileName}`}>
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          {active ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onCancelJob(job.id)} aria-label={`Cancel ${job.fileName}`}>
              <Square className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={() => onRemoveJob(job.id)} aria-label={`Remove ${job.fileName}`}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {active ? (
        <div className="border-t border-[var(--line)]/55 px-3 pb-3 pt-2">
          <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted)]">
            <span className="min-w-0 break-words">{job.progressLabel}</span>
            <span className="shrink-0 tabular-nums">{Math.round(job.progressPercent * 100)}%</span>
          </div>
          <div className="mt-2">
            <Progress value={job.progressPercent * 100} label={`${job.fileName}: ${job.progressLabel}`} />
          </div>
        </div>
      ) : null}

      {errorDisplay ? (
        <div className="border-t border-[color:var(--danger)]/20 px-3 pb-3 pt-2 text-sm leading-6 text-[var(--danger)]">
          {errorDisplay.summary}
          {errorDisplay.detail ? (
            <details className="mt-2 rounded-[14px] border border-[color:var(--danger)]/20 bg-[color:var(--danger)]/10 px-3 py-2 text-xs leading-5 text-[var(--ink)]/85">
              <summary className="cursor-pointer font-semibold uppercase tracking-[0.14em] text-[var(--danger)]">
                Why it failed
              </summary>
              <p className="mt-2 normal-case tracking-normal text-[var(--ink)]/75">{errorDisplay.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia(query);
    const handleChange = () => setMatches(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

export function TruePeakWorkbench() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sessionInputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_TARGET_PRESET.id);
  const [customTargetLufs, setCustomTargetLufs] = useState("-14");
  const [customTruePeak, setCustomTruePeak] = useState("-1");
  const [targetTolerance, setTargetTolerance] = useState(String(DEFAULT_TARGET_PRESET.toleranceLufs));
  const [customPolicy, setCustomPolicy] = useState<TargetPreset["policy"]>("protect-true-peak");
  const [decodePreference, setDecodePreference] = useState<DecodePreference>("auto");
  const preferredUiMode = useSyncExternalStore<UiMode>(subscribeUiModePreference, readUiModePreference, () => "simple");
  const historyEnabled = useSyncExternalStore(subscribeHistoryPreference, readHistoryPreference, () => false);
  const theme = useSyncExternalStore<WorkspaceTheme>(subscribeThemePreference, readThemePreference, () => "dark");
  const parallelPreference = useSyncExternalStore<ParallelLanesPreference>(subscribeParallelPreference, readParallelPreference, () => "auto");
  const setParallelPreference = useCallback((next: ParallelLanesPreference) => {
    writeParallelPreference(next);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggleTheme = useCallback(() => {
    writeThemePreference(theme === "dark" ? "light" : "dark");
  }, [theme]);
  const [isDragging, setIsDragging] = useState(false);
  const [uiNotice, setUiNotice] = useState<string | null>(null);
  const uiNoticeTimeoutRef = useRef<number | null>(null);
  const [lastValidTarget, setLastValidTarget] = useState<TargetPreset>(DEFAULT_TARGET_PRESET);
  const isLargeScreen = useMediaQuery("(min-width: 1024px)");
  const routeStateRef = useRef("");
  const workspaceTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const advancedInspectorSectionRef = useRef<HTMLElement | null>(null);
  const advancedInspectorHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingInspectorFocusRef = useRef(false);
  const [inspectorFocusRequest, setInspectorFocusRequest] = useState(0);
  const [confirmDialogState, setConfirmDialogState] = useState<ConfirmDialogState>(null);

  const uiModeParam = searchParams.get("ui");
  const uiMode: UiMode = uiModeParam === "advanced" || uiModeParam === "simple" ? (uiModeParam as UiMode) : preferredUiMode;
  const analysisModeParam = searchParams.get("analysis");
  const analysisMode: AnalysisMode = analysisModeParam === "measure-only" ? "measure-only" : "targeted";
  const workspaceScreenParam = searchParams.get("screen");
  const workspaceScreen: WorkspaceScreen = workspaceScreenParam === "session" ? "session" : "home";
  const tabParam = searchParams.get("tab");
  const workspaceTab: WorkspaceTab = tabParam != null && SESSION_TABS.some((tab) => tab.id === tabParam) ? (tabParam as WorkspaceTab) : "queue";
  const detailParam = searchParams.get("detail");
  const detailTab: DetailTab = detailParam != null && DETAIL_TABS.some((tab) => tab.id === detailParam) ? (detailParam as DetailTab) : "overview";
  const drawerParam = searchParams.get("drawer");
  const workspaceDrawer: WorkspaceDrawer = drawerParam === "presets" || drawerParam === "inspector" || drawerParam === "history" ? (drawerParam as WorkspaceDrawer) : "none";
  const selectedJobId = searchParams.get("job");
  const referenceParam = searchParams.get("reference");
  const referenceId = referenceParam === "none" ? null : referenceParam;
  const compareViewParam = searchParams.get("compareView");
  const compareView: CompareView = compareViewParam === "board" || compareViewParam === "reference" || compareViewParam === "table" ? (compareViewParam as CompareView) : "cards";
  const compareFilterParam = searchParams.get("compareFilter");
  const compareFilter: CompareFilter = compareFilterParam === "on-target" || compareFilterParam === "attention" ? (compareFilterParam as CompareFilter) : "all";
  const compareSortParam = searchParams.get("compareSort");
  const compareSort: CompareSort = compareSortParam === "truePeak" || compareSortParam === "lra" || compareSortParam === "gain" || compareSortParam === "duration" || compareSortParam === "name" ? (compareSortParam as CompareSort) : "integrated";
  const compareDirectionParam = searchParams.get("compareDirection");
  const compareDirection: SortDirection = compareDirectionParam === "asc" || compareDirectionParam === "desc" ? (compareDirectionParam as SortDirection) : compareSort === "name" ? "asc" : "desc";
  const queueFilterParam = searchParams.get("filter");
  const queueFilter: QueueFilter = queueFilterParam != null && QUEUE_FILTERS.some((filter) => filter.id === queueFilterParam) ? (queueFilterParam as QueueFilter) : "all";
  const queueSortParam = searchParams.get("sort");
  const queueSort: QueueSort = queueSortParam != null && QUEUE_SORTS.some((option) => option.id === queueSortParam) ? (queueSortParam as QueueSort) : "recent";
  const searchQuery = searchParams.get("search") ?? "";
  const [queueSearchDraft, setQueueSearchDraft] = useState(searchQuery);
  const deferredSearchQuery = useDeferredValue(queueSearchDraft.trim().toLowerCase());

  useEffect(() => {
    routeStateRef.current = searchParams.toString();
  }, [searchParams]);

  useEffect(() => {
    setQueueSearchDraft((current) => (current === searchQuery ? current : searchQuery));
  }, [searchQuery]);

  const updateWorkspaceRoute = useCallback((updates: Record<string, string | null>) => {
    const currentSearch = routeStateRef.current || searchParams.toString();
    const nextParams = new URLSearchParams(currentSearch);
    Object.entries(updates).forEach(([key, value]) => {
      if (value == null || value === "") {
        nextParams.delete(key);
        return;
      }

      nextParams.set(key, value);
    });

    const nextQuery = nextParams.toString();
    routeStateRef.current = nextQuery;
    startTransition(() => {
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    });
  }, [pathname, router, searchParams]);

  const setWorkspaceScreen = (screen: WorkspaceScreen) => {
    if (screen === "home") {
      updateWorkspaceRoute({ screen: "home", tab: null, detail: null, job: null, drawer: null });
      return;
    }

    updateWorkspaceRoute({ screen: "session" });
  };

  const setWorkspaceTab = (tab: WorkspaceTab) => {
    updateWorkspaceRoute({
      screen: "session",
      tab,
      detail: tab === "queue" ? detailTab : null,
      drawer: tab === "queue" && workspaceDrawer === "presets" ? "presets" : null,
    });
  };

  const setDetailTab = (tab: DetailTab) => {
    updateWorkspaceRoute({ detail: tab });
  };

  const setWorkspaceDrawer = (drawer: WorkspaceDrawer) => {
    updateWorkspaceRoute({ drawer: drawer === "none" ? null : drawer });
  };

  const setUiMode = (next: UiMode) => {
    writeUiModePreference(next);
    updateWorkspaceRoute(
      next === "simple"
        ? {
            ui: next,
            tab: null,
            compareView: null,
            compareFilter: null,
            compareSort: null,
            compareDirection: null,
            reference: null,
            drawer: workspaceDrawer === "history" ? "history" : null,
          }
        : { ui: next },
    );
  };

  const setAnalysisMode = (next: AnalysisMode) => {
    updateWorkspaceRoute({
      analysis: next === "targeted" ? null : "measure-only",
      drawer: next === "measure-only" && workspaceDrawer === "presets" ? null : workspaceDrawer === "history" ? "history" : null,
    });
  };

  const setReferenceId = (next: string | null) => {
    updateWorkspaceRoute({ reference: next });
  };

  const setCompareView = (next: CompareView) => {
    updateWorkspaceRoute({ compareView: next === "cards" ? null : next });
  };

  const setCompareFilter = (next: CompareFilter) => {
    updateWorkspaceRoute({ compareFilter: next === "all" ? null : next });
  };

  const setCompareSort = (next: CompareSort) => {
    const nextDirection =
      compareSort === next
        ? compareDirection === "asc"
          ? "desc"
          : "asc"
        : next === "name"
          ? "asc"
          : "desc";

    updateWorkspaceRoute({
      compareSort: next === "integrated" ? null : next,
      compareDirection: nextDirection === "desc" ? null : nextDirection,
    });
  };

  const setQueueFilter = (next: QueueFilter) => {
    const normalizedSearch = queueSearchDraft.trim();
    updateWorkspaceRoute({
      search: normalizedSearch ? queueSearchDraft : null,
      filter: next === "all" ? null : next,
    });
  };

  const setQueueSort = (next: QueueSort) => {
    const normalizedSearch = queueSearchDraft.trim();
    updateWorkspaceRoute({
      search: normalizedSearch ? queueSearchDraft : null,
      sort: next === "recent" ? null : next,
    });
  };

  const setSearchQuery = (next: string) => {
    setQueueSearchDraft(next);
  };

  useEffect(() => {
    const trimmedDraft = queueSearchDraft.trim();
    const trimmedQuery = searchQuery.trim();
    if (trimmedDraft === trimmedQuery) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const currentSearch = routeStateRef.current || searchParams.toString();
      const nextParams = new URLSearchParams(currentSearch);
      if (trimmedDraft) {
        nextParams.set("search", queueSearchDraft);
      } else {
        nextParams.delete("search");
      }

      const nextQuery = nextParams.toString();
      routeStateRef.current = nextQuery;
      startTransition(() => {
        router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
      });
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [pathname, queueSearchDraft, router, searchParams, searchQuery]);

  const setHistoryEnabled = (next: boolean) => {
    if (!next && workspaceDrawer === "history") {
      updateWorkspaceRoute({ drawer: null });
    }

    writeHistoryPreference(next);
  };

  const toggleHistoryEnabled = () => setHistoryEnabled(!historyEnabled);

  const targetValidation = useMemo(() => {
    const errors: TargetFieldErrors = {};
    const toleranceValue = parseTargetNumber(targetTolerance);

    if (toleranceValue == null || toleranceValue <= 0) {
      errors.targetTolerance = "Enter a tolerance greater than 0 LU.";
    }

    if (selectedPresetId === CUSTOM_ID) {
      if (parseTargetNumber(customTargetLufs) == null) {
        errors.customTargetLufs = "Enter a numeric LUFS target.";
      }

      if (parseTargetNumber(customTruePeak) == null) {
        errors.customTruePeak = "Enter a numeric dBTP ceiling.";
      }
    }

    return {
      errors,
      isValid: Object.keys(errors).length === 0,
      message:
        errors.targetTolerance ??
        errors.customTargetLufs ??
        errors.customTruePeak ??
        null,
    };
  }, [customTargetLufs, customTruePeak, selectedPresetId, targetTolerance]);

  const validatedTarget = useMemo<TargetPreset | null>(() => {
    const toleranceLufs = parseTargetNumber(targetTolerance);
    if (toleranceLufs == null || toleranceLufs <= 0) {
      return null;
    }

    if (selectedPresetId !== CUSTOM_ID) {
      const preset = TARGET_PRESETS.find((presetOption) => presetOption.id === selectedPresetId) ?? DEFAULT_TARGET_PRESET;
      return { ...preset, toleranceLufs };
    }

    const loudnessTargetLufs = parseTargetNumber(customTargetLufs);
    const truePeakCeilingDbtp = parseTargetNumber(customTruePeak);
    if (loudnessTargetLufs == null || truePeakCeilingDbtp == null) {
      return null;
    }

    return {
      id: CUSTOM_ID,
      label: "Custom",
      category: "custom",
      evidence: "custom",
      sourceLabel: "Manual target",
      referenceNote:
        "Use this when you already have a client, label, or distributor specification that is not covered by the preset library.",
      highlights: ["Manual spec", "Session-specific", "User-defined"],
      loudnessTargetLufs,
      truePeakCeilingDbtp,
      toleranceLufs,
      policy: customPolicy,
      description:
        customPolicy === "protect-true-peak"
          ? "Manual target with true-peak protection for safer normalization planning."
          : "Manual target that prioritizes hitting loudness even if headroom is exceeded.",
    };
  }, [customPolicy, customTargetLufs, customTruePeak, selectedPresetId, targetTolerance]);
  const currentTarget = validatedTarget ?? lastValidTarget;
  const targetInputBlocked = analysisMode === "targeted" && !targetValidation.isValid;

  useEffect(() => {
    if (validatedTarget) {
      setLastValidTarget(validatedTarget);
    }
  }, [validatedTarget]);

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

  const {
    jobs,
    completedJobs,
    recentSessions,
    notice,
    parallelLimit,
    enqueueFiles,
    cancelJob,
    cancelActiveJobs,
    retryJob,
    retryIssues,
    removeJob,
    clearFinished,
    clearSession,
    clearRecentSessions,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportSession,
    importSession,
  } = useTruePeakAnalyzer(currentTarget, {
    analysisBlocked: targetInputBlocked,
    analysisMode,
    decodePreference,
    persistHistory: historyEnabled,
    parallelPreference,
  });

  const filteredJobs = useMemo(
    () =>
      jobs.filter((job) => {
        const matchesFilter =
          queueFilter === "all" ||
          (queueFilter === "active" && isActiveJob(job)) ||
          (queueFilter === "complete" && job.status === "complete") ||
          (queueFilter === "issues" && isIssueJob(job));
        const searchTargets = [job.fileName, job.status, job.result?.metadata.decoderLabel ?? "", job.result?.metadata.channelLayout.name ?? "", job.result?.target?.label ?? "", job.result ? getComplianceSummary(job.result)?.label ?? "" : ""];
        const matchesSearch = !deferredSearchQuery || searchTargets.some((value) => value.toLowerCase().includes(deferredSearchQuery));
        return matchesFilter && matchesSearch;
      }),
    [deferredSearchQuery, jobs, queueFilter],
  );

  const sortedQueueJobs = useMemo(() => [...filteredJobs].sort((left, right) => sortQueueJobs(left, right, queueSort)), [filteredJobs, queueSort]);
  // Latest-value ref so selection handlers can consult the visible queue without
  // taking sortedQueueJobs as a dependency (it changes on every progress tick,
  // which would give selectJob/chooseJob a new identity and defeat row memoization).
  const sortedQueueJobsRef = useRef(sortedQueueJobs);
  useEffect(() => {
    sortedQueueJobsRef.current = sortedQueueJobs;
  }, [sortedQueueJobs]);
  const resolvedSelectedJobId =
    selectedJobId && jobs.some((job) => job.id === selectedJobId)
      ? selectedJobId
      : sortedQueueJobs[0]?.id ?? jobs[0]?.id ?? null;
  const activeWorkspaceTab: WorkspaceTab = uiMode === "simple" ? "queue" : workspaceTab;
  const routeSelectedJob = useMemo(
    () => (selectedJobId ? jobs.find((job) => job.id === selectedJobId) ?? null : null),
    [jobs, selectedJobId],
  );
  const visibleSelectedJob = useMemo(
    () => sortedQueueJobs.find((job) => job.id === routeSelectedJob?.id) ?? null,
    [routeSelectedJob?.id, sortedQueueJobs],
  );
  const selectedJob = useMemo(() => {
    if (activeWorkspaceTab === "queue") {
      return visibleSelectedJob ?? sortedQueueJobs[0] ?? null;
    }

    return routeSelectedJob ?? completedJobs[0] ?? jobs[0] ?? null;
  }, [activeWorkspaceTab, completedJobs, jobs, routeSelectedJob, sortedQueueJobs, visibleSelectedJob]);
  const queueAverage = averageIntegratedLufs(completedJobs);
  const hottestTruePeak = highestTruePeakDbtp(completedJobs);
  const complianceCounts = useMemo(() => getComplianceCounts(completedJobs), [completedJobs]);
  const targetingEnabled = analysisMode === "targeted";
  const currentModeLabel = targetingEnabled ? currentTarget.label : "Measure Only";
  const queueCounts = useMemo(() => countQueueJobs(jobs), [jobs]);
  // Aggregate batch progress for the toolbar while anything is running.
  // The ETA is deliberately rough: median completed duration in this session,
  // scaled by how many files each parallel pass clears.
  const batchProgress = useMemo(() => {
    if (!jobs.length) {
      return null;
    }

    const activeJobs = jobs.filter(isActiveJob);
    if (!activeJobs.length) {
      return null;
    }

    const finished = jobs.length - activeJobs.length;
    const inFlightProgress = activeJobs.reduce(
      (sum, job) => sum + Math.min(Math.max(job.progressPercent, 0), 1),
      0,
    );
    const percent = ((finished + inFlightProgress) / jobs.length) * 100;

    const durations = jobs
      .filter((job) => job.status === "complete" && job.startedAtMs != null && job.finishedAtMs != null)
      .map((job) => job.finishedAtMs! - job.startedAtMs!)
      .sort((left, right) => left - right);
    const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;
    const lanes = Math.max(1, parallelLimit);
    const etaSeconds =
      median != null
        ? Math.max(1, Math.round((Math.ceil(activeJobs.length / lanes) * median) / 1000))
        : null;

    return { finished, total: jobs.length, percent, etaSeconds };
  }, [jobs, parallelLimit]);
  const visibleQueueCount = sortedQueueJobs.length;
  const queueViewIsFiltered = queueSearchDraft.trim().length > 0 || queueFilter !== "all" || queueSort !== "recent";
  const queueShownLabel = queueViewIsFiltered
    ? `${visibleQueueCount} of ${jobs.length} shown`
    : `${visibleQueueCount} shown`;
  const sessionTabCounts: Record<WorkspaceTab, number> = { queue: jobs.length, compare: completedJobs.length, insights: completedJobs.length };
  const finishedCount = queueCounts.complete + queueCounts.issues;
  const activeNotice = uiNotice ?? notice;
  const showHomeSupportSection = jobs.length > 0 || historyEnabled || recentSessions.length > 0;
  const queueEmptyCopy = jobs.length
    ? {
        title: "No files match this view",
        body: "Reset the queue view to show the current session again, or add more files.",
        actionLabel: "Reset View",
      }
    : {
        title: "No files queued yet",
        body: "Add audio files to start a local loudness and true-peak review.",
        actionLabel: "Add Files",
      };
  const simpleInlineInspector = activeWorkspaceTab === "queue" && uiMode === "simple" && isLargeScreen;
  const advancedInlineInspector = activeWorkspaceTab === "queue" && uiMode === "advanced";
  const showInlineInspector = !!selectedJob && (simpleInlineInspector || advancedInlineInspector);
  const inspectorDrawerOpen = workspaceDrawer === "inspector" && !!selectedJob && activeWorkspaceTab === "queue" && uiMode === "simple" && !simpleInlineInspector;

  useEffect(() => {
    const updates: Record<string, string | null> = {};

    if (selectedJobId && !jobs.some((job) => job.id === selectedJobId)) {
      updates.job = resolvedSelectedJobId;
      if (!resolvedSelectedJobId && workspaceDrawer === "inspector") {
        updates.drawer = null;
      }
    }

    if (referenceId && !completedJobs.some((job) => job.id === referenceId)) {
      updates.reference = null;
    }

    if (Object.keys(updates).length) {
      updateWorkspaceRoute(updates);
    }
  }, [completedJobs, jobs, referenceId, resolvedSelectedJobId, selectedJobId, updateWorkspaceRoute, workspaceDrawer]);

  useEffect(() => {
    const updates: Record<string, string | null> = {};
    const drawerIsPreset = workspaceDrawer === "presets";
    const drawerIsHistory = workspaceDrawer === "history";
    const drawerIsInspector = workspaceDrawer === "inspector";

    if (referenceParam === "none") {
      updates.reference = null;
    }

    if (workspaceScreen === "home") {
      if (tabParam) updates.tab = null;
      if (detailParam) updates.detail = null;
      if (selectedJobId) updates.job = null;
      if (referenceParam) updates.reference = null;
      if (queueFilterParam) updates.filter = null;
      if (queueSortParam) updates.sort = null;
      if (searchQuery) updates.search = null;
      if (compareViewParam) updates.compareView = null;
      if (compareFilterParam) updates.compareFilter = null;
      if (compareSortParam) updates.compareSort = null;
      if (compareDirectionParam) updates.compareDirection = null;
    }

    if (uiMode === "simple") {
      if (tabParam) updates.tab = null;
      if (compareViewParam) updates.compareView = null;
      if (compareFilterParam) updates.compareFilter = null;
      if (compareSortParam) updates.compareSort = null;
      if (compareDirectionParam) updates.compareDirection = null;
      if (referenceParam) updates.reference = null;
    }

    if (analysisMode === "measure-only") {
      if (compareViewParam === "board") updates.compareView = null;
      if (compareFilterParam) updates.compareFilter = null;
      if (compareSortParam === "gain") updates.compareSort = null;
    }

    if (drawerIsPreset && !targetingEnabled) {
      updates.drawer = null;
    }

    if (drawerIsHistory && !historyEnabled) {
      updates.drawer = null;
    }

    if (
      drawerIsInspector &&
      (workspaceScreen === "home" || uiMode === "advanced" || activeWorkspaceTab !== "queue" || !selectedJob)
    ) {
      updates.drawer = null;
    }

    if (Object.keys(updates).length) {
      updateWorkspaceRoute(updates);
    }
  }, [
    activeWorkspaceTab,
    analysisMode,
    compareDirectionParam,
    compareFilterParam,
    compareSortParam,
    compareViewParam,
    detailParam,
    historyEnabled,
    queueFilterParam,
    queueSortParam,
    referenceParam,
    searchQuery,
    selectedJobId,
    selectedJob,
    tabParam,
    targetingEnabled,
    uiMode,
    updateWorkspaceRoute,
    workspaceDrawer,
    workspaceScreen,
  ]);

  const showTargetInputBlock = useCallback(() => {
    pushUiNotice(targetValidation.message ?? "Fix the target settings before adding files.");
    updateWorkspaceRoute({ drawer: "presets" });
  }, [pushUiNotice, targetValidation.message, updateWorkspaceRoute]);

  const openPicker = useCallback(() => {
    if (targetInputBlocked) {
      showTargetInputBlock();
      return;
    }

    inputRef.current?.click();
  }, [showTargetInputBlock, targetInputBlocked]);

  // Desktop shortcuts: "/" focuses the queue search (when visible), Ctrl/Cmd+O
  // opens the file picker instead of the browser's own open dialog.
  const openPickerRef = useRef(openPicker);
  useEffect(() => {
    openPickerRef.current = openPicker;
  }, [openPicker]);

  useEffect(() => {
    const handleShortcuts = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inEditable = !!target?.closest("input, textarea, select, [contenteditable='true']");

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        openPickerRef.current();
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
  }, []);
  const openSessionWorkspace = () => {
    updateWorkspaceRoute({ screen: "session", tab: "queue" });
  };

  const resetQueueView = useCallback(() => {
    setQueueSearchDraft("");
    updateWorkspaceRoute({ search: null, filter: null, sort: null });
  }, [updateWorkspaceRoute]);

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    if (targetInputBlocked) {
      showTargetInputBlock();
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const added = enqueueFiles(files);
    if (added > 0) {
      updateWorkspaceRoute({ screen: "session", tab: "queue", drawer: null });
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  // Drag-and-drop is owned here, on the always-mounted workbench, so dropping
  // a file works on every screen. (It used to live in the home stage only;
  // dropping onto the session screen made the browser navigate to the file
  // and silently destroyed the in-memory session.)
  const handleDropTransfer = useCallback((dataTransfer: DataTransfer) => {
    if (targetInputBlocked) {
      showTargetInputBlock();
      return;
    }

    // Called synchronously from the drop event: collectDroppedFiles snapshots
    // the transfer's items before yielding, then walks folders asynchronously.
    void collectDroppedFiles(dataTransfer).then(({ files, truncated }) => {
      if (truncated) {
        pushUiNotice(`That drop was larger than ${numberFormatter.format(MAX_DROPPED_FILES)} files, so only the first ${numberFormatter.format(MAX_DROPPED_FILES)} were considered.`);
      }

      if (!files.length) return;
      const added = enqueueFiles(files);
      if (added > 0) {
        updateWorkspaceRoute({ screen: "session", tab: "queue", drawer: null });
      }
    });
  }, [enqueueFiles, pushUiNotice, showTargetInputBlock, targetInputBlocked, updateWorkspaceRoute]);
  const dropTransferRef = useRef(handleDropTransfer);
  useEffect(() => {
    dropTransferRef.current = handleDropTransfer;
  }, [handleDropTransfer]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => !!event.dataTransfer?.types?.includes("Files");
    // dragenter/dragleave fire for every child crossing; a depth counter keeps
    // the highlight stable until the pointer truly leaves the window.
    let depth = 0;

    const handleDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setIsDragging(true);
    };
    const handleDragOver = (event: DragEvent) => {
      if (hasFiles(event)) {
        event.preventDefault();
      }
    };
    const handleDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        setIsDragging(false);
      }
    };
    const handleDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setIsDragging(false);
      if (event.dataTransfer) {
        dropTransferRef.current(event.dataTransfer);
      }
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

  const openSessionPicker = () => {
    sessionInputRef.current?.click();
  };

  const handleSessionFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (sessionInputRef.current) sessionInputRef.current.value = "";
    if (!file) return;

    const added = await importSession(file);
    if (added > 0) {
      updateWorkspaceRoute({ screen: "session", tab: "queue", drawer: null });
    }
  };

  const retrySingleJob = useCallback((jobId: string) => {
    if (targetInputBlocked) {
      showTargetInputBlock();
      return;
    }

    retryJob(jobId);
  }, [retryJob, showTargetInputBlock, targetInputBlocked]);

  const retryIssueJobs = () => {
    if (targetInputBlocked) {
      showTargetInputBlock();
      return;
    }

    retryIssues();
  };

  const selectJob = useCallback((jobId: string, options?: { focusDetails?: boolean }) => {
    if (options?.focusDetails) {
      pendingInspectorFocusRef.current = true;
      setInspectorFocusRequest((current) => current + 1);
    }

    const shouldRevealHiddenJob =
      options?.focusDetails && !sortedQueueJobsRef.current.some((job) => job.id === jobId);
    if (shouldRevealHiddenJob) {
      setQueueSearchDraft("");
    }

    const updates: Record<string, string | null> = {
      screen: "session",
      tab: "queue",
      job: jobId,
      detail: detailTab || "overview",
      drawer: uiMode === "advanced" || simpleInlineInspector ? null : "inspector",
    };

    if (shouldRevealHiddenJob) {
      updates.filter = null;
      updates.search = null;
    }

    updateWorkspaceRoute(updates);
  }, [detailTab, simpleInlineInspector, uiMode, updateWorkspaceRoute]);

  const chooseJob = useCallback((jobId: string) => {
    selectJob(jobId, { focusDetails: uiMode === "advanced" });
  }, [selectJob, uiMode]);

  const handleQueueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shouldIgnoreQueueNavigationTarget(event.target)) return;
    if (!sortedQueueJobs.length) return;
    const currentIndex = sortedQueueJobs.findIndex((job) => job.id === selectedJob?.id);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = sortedQueueJobs[currentIndex < 0 ? 0 : Math.min(currentIndex + 1, sortedQueueJobs.length - 1)];
      if (next) selectJob(next.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = sortedQueueJobs[currentIndex < 0 ? sortedQueueJobs.length - 1 : Math.max(currentIndex - 1, 0)];
      if (previous) selectJob(previous.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectJob(sortedQueueJobs[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      selectJob(sortedQueueJobs[sortedQueueJobs.length - 1].id);
    } else if ((event.key === "Enter" || event.key === " ") && selectedJob) {
      // Open/focus the inspector for the highlighted row, matching a click.
      event.preventDefault();
      chooseJob(selectedJob.id);
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
    setWorkspaceTab(SESSION_TABS[nextIndex].id);
  };

  useEffect(() => {
    if (
      !pendingInspectorFocusRef.current ||
      uiMode !== "advanced" ||
      activeWorkspaceTab !== "queue" ||
      !selectedJob
    ) {
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
  }, [activeWorkspaceTab, inspectorFocusRequest, selectedJob, uiMode]);

  const requestRemoveJob = useCallback((jobId: string) => {
    setConfirmDialogState({ type: "remove-job", jobId });
  }, []);

  const requestClearFinished = () => {
    setConfirmDialogState({ type: "clear-finished" });
  };

  const requestClearSession = () => {
    setConfirmDialogState({ type: "clear-session" });
  };

  const requestClearHistory = () => {
    setConfirmDialogState({ type: "clear-history" });
  };

  const runConfirmedAction = () => {
    if (!confirmDialogState) {
      return;
    }

    switch (confirmDialogState.type) {
      case "remove-job":
        removeJob(confirmDialogState.jobId);
        pushUiNotice("File removed from this session.");
        break;
      case "clear-finished":
        clearFinished();
        pushUiNotice("Finished files removed from the queue.");
        break;
      case "clear-session":
        clearSession();
        pushUiNotice("Session cleared.");
        break;
      case "clear-history":
        clearRecentSessions();
        if (workspaceDrawer === "history") {
          setWorkspaceDrawer("none");
        }
        pushUiNotice("Saved history cleared.");
        break;
    }
  };

  const confirmDialogCopy =
    confirmDialogState?.type === "remove-job"
      ? {
          title: "Remove this file?",
          description:
            "This removes the file and its result from the current session. You can add it again any time.",
          confirmLabel: "Remove file",
        }
      : confirmDialogState?.type === "clear-finished"
        ? {
            title: "Clear finished files?",
            description:
              "Completed, failed, and canceled items will be removed from the current queue. Active work keeps running.",
            confirmLabel: "Clear finished",
          }
        : confirmDialogState?.type === "clear-session"
          ? {
              title: "Clear the current session?",
              description:
                "This removes every queued and completed file from the current session view. Saved history stays untouched.",
              confirmLabel: "Clear session",
            }
          : confirmDialogState?.type === "clear-history"
            ? {
                title: "Clear saved history?",
                description:
                  "This removes the local summary cards stored in this browser. It does not affect the current queue.",
                confirmLabel: "Clear history",
              }
            : null;

  const sessionOverviewCards = (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricTile label="Queued now" value={numberFormatter.format(jobs.length)} hint={jobs.length ? "Files already in the current session" : "No files queued yet"} accent={jobs.length > 0} />
      <MetricTile label="Completed" value={numberFormatter.format(completedJobs.length)} hint="Results ready to inspect or export" />
      <MetricTile label="Average LUFS" value={formatLufs(queueAverage)} hint={completedJobs.length ? "Integrated average across completed files" : "Waiting for finished analyses"} />
      <MetricTile label="Hottest true peak" value={formatPeakDbtp(hottestTruePeak)} hint={completedJobs.length ? "Highest measured peak so far" : "Waiting for finished analyses"} />
    </div>
  );

  return (
    <>
      <a href="#truepeak-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-[var(--surface-1)] focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[var(--ink)] focus:shadow-[var(--shadow-elevated)]">
        Skip to main content
      </a>
      <main id="truepeak-main" className="mx-auto flex min-h-screen w-full max-w-[1760px] flex-col gap-6 px-4 py-6 sm:px-6 xl:px-8 2xl:px-10">
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
              <div className="inline-flex items-center gap-2 rounded-full border border-[color:var(--accent)]/18 bg-[color:var(--accent-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
                <Waves className="h-3.5 w-3.5" />
                In-browser loudness analysis
              </div>
              <h1 className="mt-4"><TruePeakLogo size="lg" subtitle="Loudness and true-peak review" titleClassName="leading-none" /></h1>
              <p className="mt-3 max-w-[60rem] text-sm leading-6 text-[var(--muted)] sm:text-base">
                Load a batch, measure LUFS and true peak, and review delivery targets without sending files anywhere. Use it as a review aid, not a certified compliance meter.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ThemeToggle theme={theme} onToggle={toggleTheme} />
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

          {activeNotice ? (
            <div className="tp-notice-in flex items-start gap-3 rounded-[22px] border border-[color:var(--accent)]/15 bg-[color:var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]" role="status" aria-live="polite">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
              <span>{activeNotice}</span>
            </div>
          ) : null}

          <HomeStage
            uiMode={uiMode}
            analysisMode={analysisMode}
            decodePreference={decodePreference}
            parallelPreference={parallelPreference}
            resolvedParallelLimit={parallelLimit}
            currentTarget={targetingEnabled ? currentTarget : null}
            currentModeLabel={currentModeLabel}
            supportedFormats={SUPPORTED_FORMATS}
            decodeOptions={DECODE_PREFERENCES}
            isDragging={isDragging}
            onOpenPicker={openPicker}
            onSetUiMode={setUiMode}
            onSetAnalysisMode={setAnalysisMode}
            onSetDecodePreference={setDecodePreference}
            onSetParallelPreference={setParallelPreference}
            onOpenPresetLibrary={() => setWorkspaceDrawer("presets")}
          />

          {showHomeSupportSection ? (
          <section className="grid gap-6 xl:grid-cols-[minmax(0,1.18fr)_minmax(360px,0.82fr)] xl:items-stretch">
            <Card className="h-full min-h-[548px] p-5 sm:p-6">
              <div className="flex h-full flex-col">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Session snapshot</div>
                    <h2 className="mt-2 text-2xl font-semibold text-[var(--ink)]">See the current run at a glance</h2>
                    <p className="mt-2 max-w-[56rem] text-sm leading-6 text-[var(--muted)]">
                      Your queue and finished results stay available while you move between the home screen, the simple table view, and the advanced tools.
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
                      Choose the decode path up front, then let the rest of the review stay focused on the results.
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
                  <h2 className="mt-2 text-2xl font-semibold text-[var(--ink)]">A few defaults that keep things tidy</h2>
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
                        Completed runs stay in the current session unless you decide to keep recent analyses in this browser.
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
          <StudioToolbar
            currentModeLabel={currentModeLabel}
            uiMode={uiMode}
            decodeLabel={formatDecodePreferenceLabel(decodePreference)}
            historyEnabled={historyEnabled}
            completedCount={completedJobs.length}
            activeCount={queueCounts.active}
            finishedCount={finishedCount}
            jobsCount={jobs.length}
            parallelLimit={parallelLimit}
            batchProgress={batchProgress}
            themeControl={<ThemeToggle theme={theme} onToggle={toggleTheme} />}
            onGoHome={() => setWorkspaceScreen("home")}
            onOpenPicker={openPicker}
            onExportCsv={exportCsv}
            onExportJson={exportJson}
            onExportMarkdown={exportMarkdown}
            onExportSession={exportSession}
            onOpenSession={openSessionPicker}
            onToggleHistory={toggleHistoryEnabled}
            onOpenHistory={() => setWorkspaceDrawer("history")}
            onClearFinished={requestClearFinished}
            onCancelActive={cancelActiveJobs}
            onClearSession={requestClearSession}
          />

          {activeNotice ? (
            <div className="tp-notice-in flex items-start gap-3 rounded-[22px] border border-[color:var(--accent)]/15 bg-[color:var(--accent-soft)] px-4 py-3 text-sm text-[var(--ink)]" role="status" aria-live="polite">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
              <span>{activeNotice}</span>
            </div>
          ) : null}

          <WorkspaceSummaryRail
            analysisMode={analysisMode}
            currentTarget={targetingEnabled ? currentTarget : null}
            variant={uiMode === "advanced" ? "compact" : "default"}
            queueCount={jobs.length}
            completedCount={completedJobs.length}
            issueCount={queueCounts.issues}
            averageLufs={queueAverage}
            hottestTruePeak={hottestTruePeak}
            complianceCounts={targetingEnabled ? complianceCounts : undefined}
            onOpenPresetLibrary={() => setWorkspaceDrawer("presets")}
            onOpenCompare={() => setWorkspaceTab("compare")}
            canOpenCompare={uiMode === "advanced" && completedJobs.length > 1}
          />

          {uiMode === "advanced" ? (
            <div className="rounded-[20px] border border-[var(--line)]/70 bg-[var(--surface-1)]/72 p-1.5">
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Session views">
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
                      aria-controls={`workspace-panel-${tab.id}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setWorkspaceTab(tab.id)}
                      onKeyDown={(event) => handleWorkspaceTabKeyDown(event, index)}
                      className={cn(
                        "inline-flex min-w-[132px] flex-1 items-center justify-between gap-3 rounded-[16px] border px-3 py-2.5 text-sm font-semibold transition-[background-color,border-color,color] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                        selected
                          ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] text-[var(--ink)]"
                          : "border-[var(--line)] bg-[var(--surface-0)] text-[var(--muted)] hover:border-[color:var(--accent)]/35 hover:text-[var(--ink)]",
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {tab.label}
                      </span>
                      <span className="rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
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
                      <h2 className={cn("mt-2 font-semibold text-[var(--ink)]", uiMode === "advanced" ? "text-xl" : "text-2xl")}>
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

                  <div className={cn("flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]", uiMode === "advanced" ? "mt-4" : "mt-5")}>
                    <span className="rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-3 py-1.5">{queueShownLabel}</span>
                    <span className="rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-3 py-1.5">{queueCounts.active} active</span>
                    <span className="rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-3 py-1.5">{queueCounts.complete} complete</span>
                    <span className="rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-3 py-1.5">{queueCounts.issues} issues</span>
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
                        onChange={(event) => setSearchQuery(event.target.value)}
                        aria-label="Search files in the current session"
                        aria-keyshortcuts="/"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="Search by file, status, preset, decoder, or layout"
                        className={cn("w-full rounded-full border border-[var(--line)] bg-[var(--surface-1)] pl-11 pr-4 text-sm text-[var(--ink)] outline-none transition-[border-color,background-color] duration-200 ease-out focus:border-[var(--accent)]", uiMode === "advanced" ? "h-10" : "h-11")}
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
                      <label htmlFor="queue-sort" className={cn("inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface-1)] px-4 text-sm text-[var(--muted)]", uiMode === "advanced" ? "py-1.5" : "py-2")}>
                        <ArrowUpDown className="h-4 w-4" />
                        <span>Sort:</span>
                        <select id="queue-sort" name="queue-sort" aria-label="Sort files in the current session" value={queueSort} onChange={(event) => setQueueSort(event.target.value as QueueSort)} className="bg-transparent font-semibold text-[var(--ink)] outline-none">
                          {QUEUE_SORTS.map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                      {queueViewIsFiltered ? (
                        <Button type="button" size="sm" variant="ghost" onClick={resetQueueView} aria-label="Reset queue search, filters, and sort">
                          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
                          Reset View
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className={cn("space-y-4", uiMode === "advanced" ? "mt-4" : "mt-5")} onKeyDown={handleQueueKeyDown}>
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
                  <InspectorPanel
                    job={selectedJob}
                    analysisMode={analysisMode}
                    detailTab={detailTab}
                    completedCount={completedJobs.length}
                    onDetailTabChange={setDetailTab}
                    onOpenCompare={undefined}
                    onRetryJob={retrySingleJob}
                    onCancelJob={cancelJob}
                  />
                ) : null}

                {uiMode === "advanced" && showInlineInspector && selectedJob ? (
                  <section
                    ref={advancedInspectorSectionRef}
                    id="selected-file-details"
                    aria-labelledby="selected-file-details-heading"
                    className="min-w-0 scroll-mt-28 focus:outline-none"
                  >
                  <InspectorPanel
                    job={selectedJob}
                    analysisMode={analysisMode}
                    detailTab={detailTab}
                    headingId="selected-file-details-heading"
                    headingRef={advancedInspectorHeadingRef}
                    headingTabIndex={-1}
                    completedCount={completedJobs.length}
                    onDetailTabChange={setDetailTab}
                    onOpenCompare={() => setWorkspaceTab("compare")}
                    onRetryJob={retrySingleJob}
                    onCancelJob={cancelJob}
                  />
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
                completedJobs={completedJobs}
                currentTarget={analysisMode === "targeted" ? currentTarget : null}
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
                onOpenJob={(jobId) => {
                  chooseJob(jobId);
                  setWorkspaceTab("queue");
                }}
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
                completedJobs={completedJobs}
                currentTarget={analysisMode === "targeted" ? currentTarget : null}
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
          onClose={() => setConfirmDialogState(null)}
          onConfirm={runConfirmedAction}
        />
      ) : null}

      <PresetLibraryDrawer
        open={workspaceDrawer === "presets" && targetingEnabled}
        onClose={() => setWorkspaceDrawer("none")}
        currentTarget={currentTarget}
        fieldErrors={targetValidation.errors}
        selectedPresetId={selectedPresetId}
        targetTolerance={targetTolerance}
        customTargetLufs={customTargetLufs}
        customTruePeak={customTruePeak}
        customPolicy={customPolicy}
        onSelectPreset={setSelectedPresetId}
        onTargetToleranceChange={setTargetTolerance}
        onCustomTargetLufsChange={setCustomTargetLufs}
        onCustomTruePeakChange={setCustomTruePeak}
        onCustomPolicyChange={setCustomPolicy}
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
        {selectedJob ? (
          <InspectorPanel
            job={selectedJob}
            analysisMode={analysisMode}
            detailTab={detailTab}
            completedCount={completedJobs.length}
            onDetailTabChange={setDetailTab}
            onOpenCompare={uiMode === "advanced" ? () => setWorkspaceTab("compare") : undefined}
            onRetryJob={retrySingleJob}
            onCancelJob={cancelJob}
          />
        ) : null}
      </DrawerPanel>
      </main>
    </>
  );
}
















































































