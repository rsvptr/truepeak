import type { CountingSemaphore } from "@/audio/decode-window";
import type { DecodeBudget, DecodeProbeMetadata } from "@/audio/decode-budget";
import type {
  AnalysisJob,
  AnalysisMode,
  DecodePreference,
  DecodedAudioTransfer,
  TargetPreset,
} from "@/types/audio";
import type { DecodeResourceUsage } from "@/workers/shared/messages";
import type { JobStore } from "@/analysis/job-store";
import type { LaneReservations } from "@/analysis/lane-reservations";

export type MutableCell<T> = { current: T };

export type KnownSourceMetadata = DecodeProbeMetadata & {
  bitDepth?: number;
  label: string;
  frameCountExact: boolean;
};

export interface DecodeReservation {
  readonly plannedPeakBytes: number;
  peakBytes: number;
  exclusive: boolean;
  released: boolean;
}

export interface LaneLease {
  readonly laneId: number;
  readonly generation: number;
  readonly jobId: string;
  readonly runToken: number;
  readonly reservation: DecodeReservation;
  readonly browserAbortController: AbortController;
}

export type JobResourcePlan =
  | { kind: "preparing" }
  | {
      kind: "known";
      decodedBytes: number;
      trustedNative: boolean;
      sourceMetadata: KnownSourceMetadata;
    }
  | { kind: "unknown" }
  | { kind: "rejected"; error: string }
  | {
      kind: "escalated";
      reservationPeakBytes: number;
      exclusive: boolean;
      route: "browser-only" | "compatibility-only";
      decodedBytes: number | null;
      sourceMetadata: KnownSourceMetadata | null;
      escalations: number;
    };

export interface WorkerLane {
  id: number;
  decoder: Worker | null;
  analyzer: Worker | null;
  workerEpoch: number;
  leaseGeneration: number;
  lease: LaneLease | null;
  retireAfterRelease: boolean;
  failureStreak: number;
}

export interface LaneTransport {
  attach: (lane: WorkerLane) => Error | null;
  dispose: (lane: WorkerLane) => void;
  run: (
    lane: WorkerLane,
    lease: LaneLease,
    target: TargetPreset | null,
    analysisMode: AnalysisMode,
    decodePreference: DecodePreference,
  ) => Promise<void>;
}

export interface AnalyzerSettings {
  allowCompatibilityDecoder: boolean;
  analysisBlocked: boolean;
  analysisMode: AnalysisMode;
  decodePreference: DecodePreference;
  target: TargetPreset | null;
}

export interface DecodedWorkerResult {
  asset: DecodedAudioTransfer;
  usage: DecodeResourceUsage;
}

export interface RunAnalysisJobContext {
  files: MutableCell<Map<string, File>>;
  resourcePlans: MutableCell<Map<string, JobResourcePlan>>;
  decodeBudget: MutableCell<DecodeBudget>;
  heavyFileBytes: MutableCell<number>;
  browserDecodeWindow: MutableCell<CountingSemaphore>;
  settings: MutableCell<AnalyzerSettings>;
  updateJobIfRunCurrent: (
    jobId: string,
    runToken: number,
    updater: (job: AnalysisJob) => AnalysisJob,
  ) => void;
  isJobRunCurrent: (jobId: string, runToken: number) => boolean;
  releaseLane: (lane: WorkerLane, lease: LaneLease, terminalSuccess: boolean) => void;
  fillLanes: () => void;
  startBrowserDecodeHeartbeat: (jobId: string, runToken: number) => number;
  growLeasePeakReservation: (
    lane: WorkerLane,
    lease: LaneLease,
    targetPeakBytes: number,
    exclusive: boolean,
  ) => void;
  decodeInWorker: (
    lane: WorkerLane,
    lease: LaneLease,
    file: File,
    mimeType: string,
  ) => Promise<DecodedWorkerResult>;
  analyzeInWorker: (
    lane: WorkerLane,
    lease: LaneLease,
    asset: DecodedAudioTransfer,
    target: TargetPreset | null,
  ) => Promise<AnalysisJob["result"]>;
  validateDecodedAssetForLease: (
    lane: WorkerLane,
    lease: LaneLease,
    asset: DecodedAudioTransfer,
    usage: DecodeResourceUsage | undefined,
    decodedByBrowser: boolean,
  ) => void;
  resolveBrowserFirstRoute: (
    preference: DecodePreference,
    fileName: string,
    mimeType: string,
    knownFootprint: boolean,
    trustedNative: boolean,
  ) => boolean;
  normalizeDecodeFailure: (
    message: string,
    preference: DecodePreference,
    failureCode: import("@/audio/decode-budget").DecodeFailureCode | undefined,
    budget: DecodeBudget,
  ) => string;
  isWorkerTransportError: (error: unknown) => boolean;
  isCancellationReason: (message: string) => boolean;
}

export interface AnalysisSchedulerContext {
  jobStore: JobStore;
  workspaceOpen: MutableCell<boolean>;
  settings: MutableCell<AnalyzerSettings>;
  workerCircuitOpen: MutableCell<boolean>;
  lanes: MutableCell<WorkerLane[]>;
  laneLimit: MutableCell<number>;
  laneSequence: MutableCell<number>;
  files: MutableCell<Map<string, File>>;
  resourcePlans: MutableCell<Map<string, JobResourcePlan>>;
  preparingPlanCount: MutableCell<number>;
  heavyFileBytes: MutableCell<number>;
  decodeBudget: MutableCell<DecodeBudget>;
  // The lane and aggregate-reservation bookkeeping the admission scan shares
  // with the release path.
  reservations: LaneReservations;
  transport: LaneTransport;
  prepareResourcePlan: (jobId: string, file: File) => Promise<void>;
  updateJob: (jobId: string, updater: (job: AnalysisJob) => AnalysisJob) => void;
  beginJobRun: (jobId: string) => number;
  resolveBrowserFirstRoute: (
    preference: DecodePreference,
    fileName: string,
    mimeType: string,
    knownFootprint: boolean,
    trustedNative: boolean,
  ) => boolean;
}
