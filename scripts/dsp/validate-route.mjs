import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./alias-loader.mjs", import.meta.url);

const {
  normalizeWorkspaceRoute,
  parseWorkspaceRoute,
} = await import("../../src/lib/workspace-route.ts");

/** @typedef {import("../../src/lib/workspace-route.ts").WorkspaceRouteDefaults} WorkspaceRouteDefaults */
/** @typedef {import("../../src/lib/workspace-route.ts").NormalizeWorkspaceRouteOptions} NormalizeWorkspaceRouteOptions */

/**
 * @param {string} name
 * @param {unknown} actual
 * @param {unknown} expected
 */
function check(name, actual, expected) {
  test(name, () => {
    assert.deepEqual(actual, expected);
  });
}

/**
 * @param {string} search
 * @param {Partial<WorkspaceRouteDefaults>} [defaults]
 */
function route(search, defaults = {}) {
  return parseWorkspaceRoute(new URLSearchParams(search), {
    persistedAnalysisMode: defaults.persistedAnalysisMode ?? "targeted",
    preferredUiMode: defaults.preferredUiMode ?? "advanced",
  });
}

/**
 * @param {string} search
 * @param {Partial<WorkspaceRouteDefaults & NormalizeWorkspaceRouteOptions>} [options]
 */
function normalize(search, options = {}) {
  return normalizeWorkspaceRoute(route(search, options), {
    completedJobIds: options.completedJobIds ?? new Set(),
    historyEnabled: options.historyEnabled ?? true,
    jobIds: options.jobIds ?? new Set(),
    resolvedSelectedJobId: options.resolvedSelectedJobId ?? null,
    restoreSettled: options.restoreSettled ?? true,
    selectedJobAvailable: options.selectedJobAvailable ?? false,
    showInlineInspector: options.showInlineInspector ?? false,
  });
}

check(
  "screen=home strips session-only route state",
  normalize("screen=home&tab=compare&detail=timeline&job=a&reference=b&filter=issues&sort=name&search=kick&compareView=table&compareFilter=attention&compareSort=lra&compareDirection=asc"),
  {
    tab: null,
    detail: null,
    job: null,
    reference: null,
    filter: null,
    sort: null,
    search: null,
    compareView: null,
    compareFilter: null,
    compareSort: null,
    compareDirection: null,
  },
);

check(
  "ui=simple strips advanced compare state",
  normalize("screen=session&ui=simple&tab=compare&reference=a&compareView=reference&compareFilter=attention&compareSort=name&compareDirection=asc"),
  {
    tab: null,
    reference: null,
    compareView: null,
    compareFilter: null,
    compareSort: null,
    compareDirection: null,
  },
);

const measureOnlyRoute = route("screen=session&ui=advanced&analysis=measure-only&tab=compare&compareView=board&compareFilter=attention&compareSort=gain");
check(
  "measure-only resolves unsupported compare choices before write-back",
  {
    compareFilter: measureOnlyRoute.compareFilter,
    compareSort: measureOnlyRoute.compareSort,
    compareView: measureOnlyRoute.compareView,
  },
  { compareFilter: "all", compareSort: "integrated", compareView: "cards" },
);
check(
  "measure-only strips unsupported compare params",
  normalize("screen=session&ui=advanced&analysis=measure-only&tab=compare&compareView=board&compareFilter=attention&compareSort=gain"),
  { compareView: null, compareFilter: null, compareSort: null },
);

check(
  "preset drawer closes outside targeted mode",
  normalize("screen=session&ui=advanced&analysis=measure-only&drawer=presets"),
  { drawer: null },
);

check(
  "unknown job remains intact until restore settles",
  normalize("screen=session&ui=advanced&drawer=inspector&job=missing", {
    restoreSettled: false,
  }),
  {},
);

check(
  "unknown job falls back after restore settles",
  normalize("screen=session&ui=advanced&drawer=inspector&job=missing", {
    jobIds: new Set(["first"]),
    resolvedSelectedJobId: "first",
    selectedJobAvailable: true,
  }),
  { job: "first" },
);

check(
  "reference=none is removed from the canonical URL",
  normalize("screen=session&ui=advanced&reference=none"),
  { reference: null },
);
