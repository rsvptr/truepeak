// React server-render smoke for the TSX loader and a real result component.
// Run: npm run test:render
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

process.env.TRUEPEAK_RENDER_SMOKE = "1";
const navigationStubUrl = `data:text/javascript,${encodeURIComponent(`
  export function usePathname() { throw new Error("navigation smoke stub called"); }
  export function useSearchParams() { throw new Error("navigation smoke stub called"); }
`)}`;
const imageStubUrl = `data:text/javascript,${encodeURIComponent(`
  export default function Image() { return null; }
`)}`;
const navigationLoaderUrl = `data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "next/navigation") {
      return { url: ${JSON.stringify(navigationStubUrl)}, shortCircuit: true };
    }
    if (specifier === "next/image") {
      return { url: ${JSON.stringify(imageStubUrl)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`;
register(navigationLoaderUrl, import.meta.url);
register("./alias-loader.mjs", import.meta.url);

/** @typedef {import("../../src/types/audio.ts").AnalysisJob} AnalysisJob */
/** @typedef {import("../../src/audio/decode-budget.ts").DecodeFailureCode} DecodeFailureCode */
/** @typedef {import("../../src/components/workspace-contexts.tsx").WorkspaceCommandContextValue} WorkspaceCommandContextValue */
/** @typedef {import("../../src/components/workspace-contexts.tsx").WorkspaceSessionContextValue} WorkspaceSessionContextValue */
/**
 * @template T
 * @typedef {{ children: import("react").ReactNode, value: T }} ProviderProps
 */

const dynamicStub = (await import("next/dynamic")).default;
test("next/dynamic resolves to the Node stub", () => {
  assert.equal(typeof dynamicStub, "function");
});

// Imported before the window stub below: uPlot reads `document` at module load
// whenever `window` exists, and this module only needs the pure helper.
const { toNullGappedSeries } = await import("../../src/components/timeline-chart.tsx");

test("render smoke covers actionable errors, view-only hints, paused rows, circuit retry, one batch-idle summary, and null-gapped loudness series", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      /** @param {string} query */
      matchMedia: (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    },
  });

  try {
    const {
      buildBatchIdleAnnouncement,
      buildRecoveryNotice,
      composeJobError,
      getJobErrorDisplay,
      getViewOnlyHint,
    } = await import("../../src/lib/job-ui.ts");
    const {
      DEFAULT_DECODE_BUDGET,
      decodeFailureSummary,
      describeDeviceDecodeLimit,
    } = await import("../../src/audio/decode-budget.ts");
    const { SimpleResultsTable } = await import(
      "../../src/components/simple-results-table.tsx"
    );
    const { InspectorPanel } = await import(
      "../../src/components/inspector-panel.tsx"
    );
    const { WorkspaceCommandProvider, WorkspaceSessionProvider } = await import(
      "../../src/components/workspace-contexts.tsx"
    );
    const { WorkspaceNotices } = await import(
      "../../src/components/truepeak-workbench.tsx"
    );
    const { deriveSessionStats } = await import("../../src/lib/session-selectors.ts");
    const { makeAnalysisJob } = await import("./lib/job-fixtures.mjs");
    const fileName = "render-smoke.wav";
    const badgeText = "queued";
    const rawLimitError =
      "Audio source is 536,870,913 bytes; the safe decode limit is 536,870,912 bytes.";
    const actionableLimitError = composeJobError(
      decodeFailureSummary("source-budget-exceeded", DEFAULT_DECODE_BUDGET),
      rawLimitError,
    );
    const restoredJob = makeAnalysisJob({
      id: "render-restored",
      fileName: "restored-result.wav",
      mimeType: "audio/wav",
      status: "complete",
      createdAt: "2026-09-04T00:00:00.000Z",
      progressPercent: 1,
      progressLabel: "Complete",
      restored: true,
    });
    const html = renderToStaticMarkup(
      createElement(SimpleResultsTable, {
        analysisMode: "measure-only",
        jobs: [
          makeAnalysisJob({
            id: "render-smoke",
            fileName,
            mimeType: "audio/wav",
            status: badgeText,
            createdAt: "2026-09-04T00:00:00.000Z",
            progressPercent: 0,
            progressLabel: "Queued",
          }),
          makeAnalysisJob({
            id: "render-paused",
            fileName: "paused.wav",
            mimeType: "audio/wav",
            status: "queued",
            createdAt: "2026-09-04T00:00:01.000Z",
            progressPercent: 0,
            progressLabel: "Paused: analysis stopped",
          }),
          makeAnalysisJob({
            id: "render-failed",
            fileName: "too-large.wav",
            mimeType: "audio/wav",
            status: "failed",
            createdAt: "2026-09-04T00:00:02.000Z",
            progressPercent: 1,
            progressLabel: "Resource limit",
            error: actionableLimitError,
          }),
          restoredJob,
        ],
        selectedJobId: null,
        onCancelJob: () => undefined,
        onOpenJob: () => undefined,
        onRemoveJob: () => undefined,
        onRetryJob: () => undefined,
      }),
    );

    assert.ok(html.includes(fileName), "rendered output should contain the file name");
    assert.ok(html.includes(`>${badgeText}<`), "rendered output should contain the status badge");
    assert.ok(html.includes(">Paused<"), "a circuit-open queued row should render as paused");
    assert.ok(
      html.includes("On this device, source files can be up to 512 MB"),
      "the visible refusal should state the resolved device limit",
    );
    assert.ok(
      html.includes("Try a smaller file or another device."),
      "the visible refusal should keep the recovery advice in its summary",
    );
    assert.equal(
      html.match(/Why it failed/g)?.length,
      1,
      "the queue should server-render one breakpoint presentation instead of both hidden branches",
    );
    assert.ok(
      html.includes("This restored result is view-only."),
      "restored rows should explain their view-only state",
    );

    const scaleHtml = renderToStaticMarkup(
      createElement(SimpleResultsTable, {
        analysisMode: "targeted",
        jobs: Array.from({ length: 61 }, (_, index) => makeAnalysisJob({
          id: `scale-${index}`,
          fileName: `scale-${index}.wav`,
          mimeType: "audio/wav",
          status: "queued",
          createdAt: new Date(index).toISOString(),
          progressPercent: 0,
          progressLabel: "Queued",
        })),
        selectedJobId: null,
        onCancelJob: () => undefined,
        onOpenJob: () => undefined,
        onRemoveJob: () => undefined,
        onRetryJob: () => undefined,
      }),
    );
    assert.equal(
      scaleHtml.match(/data-job-id=/g)?.length,
      60,
      "the simple queue should mount at most one 60-row window",
    );
    assert.ok(scaleHtml.includes("Showing 1-60 of 61 files"));

    const errorDisplay = getJobErrorDisplay(actionableLimitError);
    assert.ok(errorDisplay?.summary.includes("Try a smaller file"));
    assert.equal(errorDisplay?.detail, rawLimitError);
    assert.equal(
      describeDeviceDecodeLimit(DEFAULT_DECODE_BUDGET),
      "On this device, source files can be up to 512 MB, with working memory for about 12 minutes of stereo 48 kHz audio.",
    );
    /** @type {DecodeFailureCode[]} */
    const failureCodes = [
      "cancelled",
      "source-budget-exceeded",
      "decoded-budget-exceeded",
      "output-budget-exceeded",
      "channel-limit-exceeded",
      "frame-limit-exceeded",
      "duration-limit-exceeded",
      "time-limit-exceeded",
      "truncated-output",
      "invalid-metadata",
      "metadata-unavailable",
      "decoder-busy",
      "decode-failed",
    ];
    for (const code of failureCodes) {
      const summary = decodeFailureSummary(code, DEFAULT_DECODE_BUDGET);
      assert.ok(summary.length > 0, `${code} should have a plain summary`);
      assert.doesNotMatch(
        summary,
        /\b\d{6,}\b|\b\d+\s*ms\b|uncaught|worker failed/i,
        `${code} should not expose raw internal values`,
      );
      if (code !== "cancelled") {
        assert.match(
          summary,
          /try|export|split|re-export|wait/i,
          `${code} should include a next step`,
        );
      }
    }
    assert.ok(
      getJobErrorDisplay(rawLimitError)?.summary.includes("Try a smaller file"),
      "legacy raw limit failures should map to actionable copy",
    );
    assert.ok(getViewOnlyHint(restoredJob)?.includes("Add the source file again"));
    assert.ok(
      getViewOnlyHint({ ...restoredJob, restored: undefined, imported: true })?.includes(
        "has not been verified against local audio",
      ),
    );

    /** @type {AnalysisJob[]} */
    const batchJobs = [
      { ...restoredJob, id: "batch-complete", restored: undefined },
      { ...restoredJob, id: "batch-failed", restored: undefined, status: "failed" },
      { ...restoredJob, id: "batch-canceled", restored: undefined, status: "canceled" },
    ];
    assert.equal(
      buildBatchIdleAnnouncement(
        batchJobs,
        new Set(["batch-complete", "batch-failed", "batch-canceled"]),
      ),
      "All 3 files finished. 1 completed, 1 failed, 1 canceled.",
    );
    assert.equal(
      buildBatchIdleAnnouncement(
        [{ ...restoredJob, id: "batch-paused", status: "queued" }],
        new Set(["batch-paused"]),
      ),
      null,
      "a paused queue is not a finished batch",
    );
    const recoveryNotice = buildRecoveryNotice({
      restoredCount: 2,
      invalidRecordCount: 1,
      overflowRecordCount: 0,
      interruptedFileCount: 4,
    });
    assert.ok(recoveryNotice?.includes("Restored 2 view-only results"));
    assert.ok(recoveryNotice?.includes("quarantined and not restored"));
    assert.ok(recoveryNotice?.includes("4 files were still queued or running"));

    // The panel takes its job and commands from the workspace providers. It
    // reads the route, the selected job and a few commands; the rest of each
    // context value is inert filler so the providers get the complete shape
    // they declare.
    const noop = () => undefined;
    /** @type {WorkspaceCommandContextValue} */
    const commandValue = {
      currentModeLabel: "Measure only",
      currentTarget: null,
      decodeLabel: "Built-in parser",
      decodePreference: "auto",
      compatibilityDecoderAllowed: false,
      connectionSavingStatus: "normal",
      historyEnabled: false,
      isDragging: false,
      parallelPreference: "auto",
      route: {
        analysisMode: "measure-only",
        detailTab: "overview",
        uiMode: "simple",
      },
      cancelActiveJobs: noop,
      cancelJob: noop,
      clearSession: noop,
      exportCsv: noop,
      exportJson: noop,
      exportMarkdown: noop,
      exportSession: noop,
      goHome: noop,
      openCompare: noop,
      openHistory: noop,
      openPicker: noop,
      openPresetLibrary: noop,
      openSessionPicker: noop,
      requestClearFinished: noop,
      requestClearSession: noop,
      retryJob: noop,
      setAnalysisMode: noop,
      setCompatibilityDecoderAllowed: noop,
      setDecodePreference: noop,
      setDetailTab: noop,
      setParallelPreference: noop,
      setUiMode: noop,
      toggleHistory: noop,
      toggleTheme: noop,
    };
    /** @type {WorkspaceSessionContextValue} */
    const sessionValue = {
      batchProgress: null,
      completedJobs: [],
      jobs: [],
      parallelLimit: 1,
      queueCounts: { all: 0, active: 0, complete: 0, issues: 0 },
      selectedJob: restoredJob,
      sessionStats: deriveSessionStats([], null, "measure-only"),
    };
    // React's createElement types list `children` as a required prop even when
    // it is passed positionally, which is how the providers receive it here.
    const inspectorHtml = renderToStaticMarkup(
      createElement(
        WorkspaceCommandProvider,
        /** @type {ProviderProps<WorkspaceCommandContextValue>} */ ({ value: commandValue }),
        createElement(
          WorkspaceSessionProvider,
          /** @type {ProviderProps<WorkspaceSessionContextValue>} */ ({ value: sessionValue }),
          createElement(InspectorPanel, {}),
        ),
      ),
    );
    assert.ok(inspectorHtml.includes("This restored result is view-only."));

    const circuitWarning =
      "Analysis is paused because the browser could not keep its local workers running. Retry analysis. If it fails again, reload the page.";
    const noticesHtml = renderToStaticMarkup(
      createElement(WorkspaceNotices, {
        persistentWarning: circuitWarning,
        transientNotice: null,
        persistentAction: {
          label: "Retry analysis",
          onClick: () => undefined,
        },
      }),
    );
    assert.ok(noticesHtml.includes(circuitWarning));
    assert.ok(noticesHtml.includes(">Retry analysis<"));

    // uPlot reads a gap as null only, so the NaN sentinels in the typed loudness
    // series must be translated before the hand-off or the chart draws nothing.
    const loudnessSeries = toNullGappedSeries(
      new Float32Array([Number.NaN, -14.25, Number.POSITIVE_INFINITY, -9.5]),
    );
    assert.deepEqual(
      loudnessSeries,
      [null, -14.25, null, -9.5],
      "non-finite timeline samples should become null gaps",
    );
    assert.ok(
      loudnessSeries.every((value) => !Number.isNaN(value)),
      "the loudness series handed to uPlot should contain no NaN",
    );
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    delete process.env.TRUEPEAK_RENDER_SMOKE;
  }
});
