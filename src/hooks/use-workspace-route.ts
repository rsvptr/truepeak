"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import {
  normalizeWorkspaceRoute,
  parseWorkspaceRoute,
  type CompareFilter,
  type CompareSort,
  type CompareView,
  type DetailTab,
  type NormalizeWorkspaceRouteOptions,
  type QueueFilter,
  type QueueSort,
  type WorkspaceDrawer,
  type WorkspaceRouteUpdates,
  type WorkspaceScreen,
  type WorkspaceTab,
} from "@/lib/workspace-route";
import {
  readUiModePreference,
  readUiModePreferenceServerSnapshot,
  subscribeUiModePreference,
  writeUiModePreference,
  type WorkspaceUiMode,
} from "@/lib/workspace-preferences";
import type { AnalysisMode } from "@/types/audio";

export interface UseWorkspaceRouteOptions {
  onAnalysisModeChange: (mode: AnalysisMode) => void;
  persistedAnalysisMode: AnalysisMode;
}

const ROUTE_CHANGE_EVENT = "truepeak:route-change";

function readLocationSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}

function subscribeLocationSearch(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(ROUTE_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(ROUTE_CHANGE_EVENT, listener);
  };
}

function publishLocationSearch() {
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
}

export function useWorkspaceRoute({
  onAnalysisModeChange,
  persistedAnalysisMode,
}: UseWorkspaceRouteOptions) {
  const pathname = usePathname();
  const locationSearch = useSyncExternalStore(
    subscribeLocationSearch,
    readLocationSearch,
    () => "",
  );
  const searchParams = useMemo(
    () => new URLSearchParams(locationSearch),
    [locationSearch],
  );
  const preferredUiMode = useSyncExternalStore<WorkspaceUiMode>(
    subscribeUiModePreference,
    readUiModePreference,
    readUiModePreferenceServerSnapshot,
  );
  const route = useMemo(
    () => parseWorkspaceRoute(searchParams, { preferredUiMode, persistedAnalysisMode }),
    [persistedAnalysisMode, preferredUiMode, searchParams],
  );
  const [queueSearchDraft, setQueueSearchDraft] = useState(route.searchQuery);
  const deferredSearchQuery = useDeferredValue(queueSearchDraft.trim().toLowerCase());
  const lastWrittenSearchRef = useRef(route.searchQuery);

  const updateWorkspaceRoute = useCallback((
    updates: WorkspaceRouteUpdates,
    options?: { history?: "push" | "replace" },
  ) => {
    const nextParams = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([key, value]) => {
      if (value == null || value === "") {
        nextParams.delete(key);
      } else {
        nextParams.set(key, value);
      }
    });

    const nextQuery = nextParams.toString();
    const nextSearch = nextQuery ? `?${nextQuery}` : "";
    if (nextSearch === window.location.search) {
      return;
    }

    const nextUrl = `${pathname}${nextSearch}`;
    if (options?.history === "push") {
      window.history.pushState(null, "", nextUrl);
    } else {
      window.history.replaceState(null, "", nextUrl);
    }
    publishLocationSearch();
  }, [pathname]);

  useEffect(() => {
    if (route.searchQuery === lastWrittenSearchRef.current) {
      return;
    }
    lastWrittenSearchRef.current = route.searchQuery;
    setQueueSearchDraft((current) => current === route.searchQuery ? current : route.searchQuery);
  }, [route.searchQuery]);

  useEffect(() => {
    const trimmedDraft = queueSearchDraft.trim();
    if (trimmedDraft === route.searchQuery.trim()) {
      return;
    }

    const timeout = window.setTimeout(() => {
      lastWrittenSearchRef.current = trimmedDraft ? queueSearchDraft : "";
      updateWorkspaceRoute({ search: trimmedDraft ? queueSearchDraft : null });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [queueSearchDraft, route.searchQuery, updateWorkspaceRoute]);

  const setWorkspaceScreen = useCallback((screen: WorkspaceScreen) => {
    if (screen === "home") {
      updateWorkspaceRoute(
        { screen: "home", tab: null, detail: null, job: null, drawer: null },
        { history: "push" },
      );
    } else {
      updateWorkspaceRoute({ screen: "session" }, { history: "push" });
    }
  }, [updateWorkspaceRoute]);

  const setWorkspaceTab = useCallback((
    tab: WorkspaceTab,
    options?: { history?: "push" | "replace" },
  ) => {
    updateWorkspaceRoute(
      {
        screen: "session",
        tab,
        detail: tab === "queue" ? route.detailTab : null,
        drawer: tab === "queue" && route.workspaceDrawer === "presets" ? "presets" : null,
      },
      { history: options?.history ?? "push" },
    );
  }, [route.detailTab, route.workspaceDrawer, updateWorkspaceRoute]);

  const setDetailTab = useCallback((tab: DetailTab) => {
    updateWorkspaceRoute({ detail: tab });
  }, [updateWorkspaceRoute]);

  const setWorkspaceDrawer = useCallback((drawer: WorkspaceDrawer) => {
    updateWorkspaceRoute(
      { drawer: drawer === "none" ? null : drawer },
      { history: drawer === "none" ? "replace" : "push" },
    );
  }, [updateWorkspaceRoute]);

  const setUiMode = useCallback((next: WorkspaceUiMode) => {
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
            drawer: route.workspaceDrawer === "history" ? "history" : null,
          }
        : { ui: next },
    );
  }, [route.workspaceDrawer, updateWorkspaceRoute]);

  const setAnalysisMode = useCallback((next: AnalysisMode) => {
    onAnalysisModeChange(next);
    updateWorkspaceRoute({
      analysis: next,
      drawer: next === "measure-only" && route.workspaceDrawer === "presets"
        ? null
        : route.workspaceDrawer === "history"
          ? "history"
          : null,
    });
  }, [onAnalysisModeChange, route.workspaceDrawer, updateWorkspaceRoute]);

  const setReferenceId = useCallback((next: string | null) => {
    updateWorkspaceRoute({ reference: next });
  }, [updateWorkspaceRoute]);

  const setCompareView = useCallback((next: CompareView) => {
    updateWorkspaceRoute({ compareView: next === "cards" ? null : next });
  }, [updateWorkspaceRoute]);

  const setCompareFilter = useCallback((next: CompareFilter) => {
    updateWorkspaceRoute({ compareFilter: next === "all" ? null : next });
  }, [updateWorkspaceRoute]);

  const setCompareSort = useCallback((next: CompareSort) => {
    const nextDirection = route.compareSort === next
      ? route.compareDirection === "asc" ? "desc" : "asc"
      : next === "name" ? "asc" : "desc";
    updateWorkspaceRoute({
      compareSort: next === "integrated" ? null : next,
      compareDirection: nextDirection === "desc" ? null : nextDirection,
    });
  }, [route.compareDirection, route.compareSort, updateWorkspaceRoute]);

  const setQueueFilter = useCallback((next: QueueFilter) => {
    updateWorkspaceRoute({
      search: queueSearchDraft.trim() ? queueSearchDraft : null,
      filter: next === "all" ? null : next,
    });
  }, [queueSearchDraft, updateWorkspaceRoute]);

  const setQueueSort = useCallback((next: QueueSort) => {
    updateWorkspaceRoute({
      search: queueSearchDraft.trim() ? queueSearchDraft : null,
      sort: next === "recent" ? null : next,
    });
  }, [queueSearchDraft, updateWorkspaceRoute]);

  const resetQueueView = useCallback(() => {
    setQueueSearchDraft("");
    updateWorkspaceRoute({ search: null, filter: null, sort: null });
  }, [updateWorkspaceRoute]);

  return useMemo(() => ({
    ...route,
    deferredSearchQuery,
    queueSearchDraft,
    resetQueueView,
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
    updateWorkspaceRoute,
  }), [
    deferredSearchQuery,
    queueSearchDraft,
    resetQueueView,
    route,
    setAnalysisMode,
    setCompareFilter,
    setCompareSort,
    setCompareView,
    setDetailTab,
    setQueueFilter,
    setQueueSort,
    setReferenceId,
    setUiMode,
    setWorkspaceDrawer,
    setWorkspaceScreen,
    setWorkspaceTab,
    updateWorkspaceRoute,
  ]);
}

export function useNormalizeWorkspaceRoute(
  route: ReturnType<typeof useWorkspaceRoute>,
  options: NormalizeWorkspaceRouteOptions,
) {
  useEffect(() => {
    const updates = normalizeWorkspaceRoute(route, options);
    if (Object.keys(updates).length) {
      route.updateWorkspaceRoute(updates);
    }
  }, [options, route]);
}
