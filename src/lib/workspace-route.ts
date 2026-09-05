import type { AnalysisMode } from "@/types/audio";
import type { WorkspaceUiMode } from "@/lib/workspace-preferences";

export type WorkspaceScreen = "home" | "session";
export type WorkspaceTab = "queue" | "compare" | "insights";
export type WorkspaceDrawer = "none" | "presets" | "inspector" | "history";
export type DetailTab = "overview" | "timeline" | "metadata";
export type QueueFilter = "all" | "active" | "complete" | "issues";
export type QueueSort = "recent" | "oldest" | "status" | "integrated" | "truePeak" | "name";
export type CompareView = "cards" | "board" | "reference" | "table";
export type CompareSort = "integrated" | "truePeak" | "lra" | "gain" | "duration" | "name";
export type CompareFilter = "all" | "on-target" | "attention";
export type SortDirection = "asc" | "desc";

export interface SearchParamsReader {
  get(name: string): string | null;
}

export interface WorkspaceRouteDefaults {
  preferredUiMode: WorkspaceUiMode;
  persistedAnalysisMode: AnalysisMode;
}

interface RawWorkspaceRoute {
  analysisMode: string | null;
  compareDirection: string | null;
  compareFilter: string | null;
  compareSort: string | null;
  compareView: string | null;
  detailTab: string | null;
  queueFilter: string | null;
  queueSort: string | null;
  referenceId: string | null;
  searchQuery: string;
  selectedJobId: string | null;
  uiMode: string | null;
  workspaceDrawer: string | null;
  workspaceScreen: string | null;
  workspaceTab: string | null;
}

export interface WorkspaceRoute {
  activeWorkspaceTab: WorkspaceTab;
  analysisMode: AnalysisMode;
  compareDirection: SortDirection;
  compareFilter: CompareFilter;
  compareSort: CompareSort;
  compareView: CompareView;
  detailTab: DetailTab;
  queueFilter: QueueFilter;
  queueSort: QueueSort;
  raw: RawWorkspaceRoute;
  referenceId: string | null;
  searchQuery: string;
  selectedJobId: string | null;
  uiMode: WorkspaceUiMode;
  workspaceDrawer: WorkspaceDrawer;
  workspaceScreen: WorkspaceScreen;
  workspaceTab: WorkspaceTab;
}

const WORKSPACE_TABS = new Set<WorkspaceTab>(["queue", "compare", "insights"]);
const DETAIL_TABS = new Set<DetailTab>(["overview", "timeline", "metadata"]);
const WORKSPACE_DRAWERS = new Set<WorkspaceDrawer>(["presets", "inspector", "history"]);
const COMPARE_VIEWS = new Set<CompareView>(["board", "reference", "table"]);
const COMPARE_FILTERS = new Set<CompareFilter>(["on-target", "attention"]);
const COMPARE_SORTS = new Set<CompareSort>(["truePeak", "lra", "gain", "duration", "name"]);
const SORT_DIRECTIONS = new Set<SortDirection>(["asc", "desc"]);
const QUEUE_FILTERS = new Set<QueueFilter>(["all", "active", "complete", "issues"]);
const QUEUE_SORTS = new Set<QueueSort>(["recent", "oldest", "status", "integrated", "truePeak", "name"]);

function oneOf<T extends string>(value: string | null, values: ReadonlySet<T>, fallback: T): T {
  return value != null && values.has(value as T) ? value as T : fallback;
}

export function parseWorkspaceRoute(
  searchParams: SearchParamsReader,
  defaults: WorkspaceRouteDefaults,
): WorkspaceRoute {
  const raw: RawWorkspaceRoute = {
    analysisMode: searchParams.get("analysis"),
    compareDirection: searchParams.get("compareDirection"),
    compareFilter: searchParams.get("compareFilter"),
    compareSort: searchParams.get("compareSort"),
    compareView: searchParams.get("compareView"),
    detailTab: searchParams.get("detail"),
    queueFilter: searchParams.get("filter"),
    queueSort: searchParams.get("sort"),
    referenceId: searchParams.get("reference"),
    searchQuery: searchParams.get("search") ?? "",
    selectedJobId: searchParams.get("job"),
    uiMode: searchParams.get("ui"),
    workspaceDrawer: searchParams.get("drawer"),
    workspaceScreen: searchParams.get("screen"),
    workspaceTab: searchParams.get("tab"),
  };

  const uiMode = oneOf(raw.uiMode, new Set<WorkspaceUiMode>(["simple", "advanced"]), defaults.preferredUiMode);
  const analysisMode = oneOf(raw.analysisMode, new Set<AnalysisMode>(["targeted", "measure-only"]), defaults.persistedAnalysisMode);
  const workspaceTab = oneOf(raw.workspaceTab, WORKSPACE_TABS, "queue");
  const parsedCompareView = oneOf(raw.compareView, COMPARE_VIEWS, "cards");
  const parsedCompareFilter = oneOf(raw.compareFilter, COMPARE_FILTERS, "all");
  const parsedCompareSort = oneOf(raw.compareSort, COMPARE_SORTS, "integrated");
  const compareView = analysisMode === "measure-only" && parsedCompareView === "board"
    ? "cards"
    : parsedCompareView;
  const compareFilter = analysisMode === "measure-only" ? "all" : parsedCompareFilter;
  const compareSort = analysisMode === "measure-only" && parsedCompareSort === "gain"
    ? "integrated"
    : parsedCompareSort;
  const compareDirection = oneOf(
    raw.compareDirection,
    SORT_DIRECTIONS,
    compareSort === "name" ? "asc" : "desc",
  );

  return {
    activeWorkspaceTab: uiMode === "simple" ? "queue" : workspaceTab,
    analysisMode,
    compareDirection,
    compareFilter,
    compareSort,
    compareView,
    detailTab: oneOf(raw.detailTab, DETAIL_TABS, "overview"),
    queueFilter: oneOf(raw.queueFilter, QUEUE_FILTERS, "all"),
    queueSort: oneOf(raw.queueSort, QUEUE_SORTS, "recent"),
    raw,
    referenceId: raw.referenceId === "none" ? null : raw.referenceId,
    searchQuery: raw.searchQuery,
    selectedJobId: raw.selectedJobId,
    uiMode,
    workspaceDrawer: oneOf(raw.workspaceDrawer, WORKSPACE_DRAWERS, "none"),
    workspaceScreen: raw.workspaceScreen === "session" ? "session" : "home",
    workspaceTab,
  };
}

export interface NormalizeWorkspaceRouteOptions {
  completedJobIds: ReadonlySet<string>;
  historyEnabled: boolean;
  jobIds: ReadonlySet<string>;
  resolvedSelectedJobId: string | null;
  restoreSettled: boolean;
  selectedJobAvailable: boolean;
  showInlineInspector: boolean;
}

export type WorkspaceRouteUpdates = Record<string, string | null>;

export function normalizeWorkspaceRoute(
  route: WorkspaceRoute,
  options: NormalizeWorkspaceRouteOptions,
): WorkspaceRouteUpdates {
  const updates: WorkspaceRouteUpdates = {};
  const { raw } = route;

  if (raw.referenceId === "none") {
    updates.reference = null;
  }

  if (route.workspaceScreen === "home") {
    if (raw.workspaceTab) updates.tab = null;
    if (raw.detailTab) updates.detail = null;
    if (raw.selectedJobId) updates.job = null;
    if (raw.referenceId) updates.reference = null;
    if (raw.queueFilter) updates.filter = null;
    if (raw.queueSort) updates.sort = null;
    if (raw.searchQuery) updates.search = null;
    if (raw.compareView) updates.compareView = null;
    if (raw.compareFilter) updates.compareFilter = null;
    if (raw.compareSort) updates.compareSort = null;
    if (raw.compareDirection) updates.compareDirection = null;
  }

  if (route.uiMode === "simple") {
    if (raw.workspaceTab) updates.tab = null;
    if (raw.compareView) updates.compareView = null;
    if (raw.compareFilter) updates.compareFilter = null;
    if (raw.compareSort) updates.compareSort = null;
    if (raw.compareDirection) updates.compareDirection = null;
    if (raw.referenceId) updates.reference = null;
  }

  if (route.analysisMode === "measure-only") {
    if (raw.compareView === "board") updates.compareView = null;
    if (raw.compareFilter) updates.compareFilter = null;
    if (raw.compareSort === "gain") updates.compareSort = null;
  }

  if (route.workspaceDrawer === "presets" && route.analysisMode !== "targeted") {
    updates.drawer = null;
  }

  if (route.workspaceDrawer === "history" && !options.historyEnabled) {
    updates.drawer = null;
  }

  if (route.workspaceDrawer === "inspector") {
    const routeDisallows = route.workspaceScreen === "home" || route.activeWorkspaceTab !== "queue";
    const selectionDisallows = options.restoreSettled && (
      options.showInlineInspector || !options.selectedJobAvailable
    );
    if (routeDisallows || selectionDisallows) {
      updates.drawer = null;
    }
  }

  if (options.restoreSettled) {
    if (raw.selectedJobId && !options.jobIds.has(raw.selectedJobId)) {
      updates.job = options.resolvedSelectedJobId;
      if (!options.resolvedSelectedJobId && route.workspaceDrawer === "inspector") {
        updates.drawer = null;
      }
    }

    if (route.referenceId && !options.completedJobIds.has(route.referenceId)) {
      updates.reference = null;
    }
  }

  return updates;
}
