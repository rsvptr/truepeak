import type { AnalysisMode, DecodePreference, TargetPreset } from "@/types/audio";
import { TARGET_PRESETS } from "@/audio/presets";

export type WorkspaceUiMode = "simple" | "advanced";
export type WorkspaceTheme = "light" | "dark";
export type ParallelLanesPreference = "auto" | "1" | "2" | "4";

const TRUEPEAK_HISTORY_PREFERENCE_KEY = "truepeak-history-enabled";
const LEGACY_HISTORY_PREFERENCE_KEYS = ["lufs-history-enabled"];
const TRUEPEAK_UI_MODE_PREFERENCE_KEY = "truepeak-ui-mode";
const LEGACY_UI_MODE_PREFERENCE_KEYS = ["lufs-ui-mode"];
const TRUEPEAK_THEME_PREFERENCE_KEY = "truepeak-theme";
const TRUEPEAK_PARALLEL_PREFERENCE_KEY = "truepeak-parallel-lanes";
const TRUEPEAK_ANALYSIS_SETTINGS_KEY = "truepeak-analysis-settings";
const ANALYSIS_SETTINGS_VERSION = 1;

const historyPreferenceListeners = new Set<() => void>();
const uiModePreferenceListeners = new Set<() => void>();
const themePreferenceListeners = new Set<() => void>();
const parallelPreferenceListeners = new Set<() => void>();
const analysisSettingsListeners = new Set<() => void>();

export interface WorkspaceAnalysisSettings {
  analysisMode: AnalysisMode;
  selectedPresetId: string;
  customTargetLufs: string;
  customTruePeak: string;
  targetTolerance: string;
  customPolicy: TargetPreset["policy"];
  decodePreference: DecodePreference;
}

interface WorkspaceAnalysisSettingsEnvelope {
  version: typeof ANALYSIS_SETTINGS_VERSION;
  settings: WorkspaceAnalysisSettings;
}

function boundedSetting(value: unknown, maxLength = 64) {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function finiteSettingNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAnalysisSettings(value: unknown): WorkspaceAnalysisSettings | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const envelope = value as Partial<WorkspaceAnalysisSettingsEnvelope>;
  if (envelope.version !== ANALYSIS_SETTINGS_VERSION || !envelope.settings) {
    return null;
  }

  const settings = envelope.settings as Partial<WorkspaceAnalysisSettings>;
  const selectedPresetId = boundedSetting(settings.selectedPresetId);
  const customTargetLufs = boundedSetting(settings.customTargetLufs);
  const customTruePeak = boundedSetting(settings.customTruePeak);
  const targetTolerance = boundedSetting(settings.targetTolerance);
  if (!selectedPresetId || customTargetLufs == null || customTruePeak == null || targetTolerance == null) {
    return null;
  }

  if (
    selectedPresetId !== "custom" &&
    !TARGET_PRESETS.some((preset) => preset.id === selectedPresetId)
  ) {
    return null;
  }
  const tolerance = finiteSettingNumber(targetTolerance);
  if (tolerance == null || tolerance <= 0) {
    return null;
  }
  if (
    selectedPresetId === "custom" &&
    (finiteSettingNumber(customTargetLufs) == null ||
      finiteSettingNumber(customTruePeak) == null)
  ) {
    return null;
  }

  if (settings.analysisMode !== "targeted" && settings.analysisMode !== "measure-only") {
    return null;
  }
  if (settings.customPolicy !== "protect-true-peak" && settings.customPolicy !== "loudness-first") {
    return null;
  }
  if (
    settings.decodePreference !== "auto" &&
    settings.decodePreference !== "browser-first" &&
    settings.decodePreference !== "compatibility-first"
  ) {
    return null;
  }

  return {
    analysisMode: settings.analysisMode,
    selectedPresetId,
    customTargetLufs,
    customTruePeak,
    targetTolerance,
    customPolicy: settings.customPolicy,
    decodePreference: settings.decodePreference,
  };
}

// The read functions below back useSyncExternalStore snapshots, so React calls
// them on every render of the workbench - the hottest path in the app during a
// batch. Cache each resolved value in module state and drop the cache whenever
// the value can change (our own writes, cross-tab storage events, and the OS
// theme media query), so a render costs a variable read instead of synchronous
// localStorage/cookie work.
const storageValueCache = new Map<string, string | null>();

function invalidateStorageValue(primaryKey: string) {
  storageValueCache.delete(primaryKey);
}

function readStorageValue(primaryKey: string, legacyKeys: string[]) {
  if (typeof window === "undefined") {
    return null;
  }

  if (storageValueCache.has(primaryKey)) {
    return storageValueCache.get(primaryKey) ?? null;
  }

  let resolved: string | null = null;
  try {
    resolved = window.localStorage.getItem(primaryKey);
    if (resolved == null) {
      for (const legacyKey of legacyKeys) {
        const legacyValue = window.localStorage.getItem(legacyKey);
        if (legacyValue != null) {
          try {
            window.localStorage.setItem(primaryKey, legacyValue);
            window.localStorage.removeItem(legacyKey);
          } catch {
            // Storage may be writable-blocked even when old values remain readable.
          }
          resolved = legacyValue;
          break;
        }
      }
    }
  } catch {
    resolved = null;
  }

  storageValueCache.set(primaryKey, resolved);
  return resolved;
}

function clearLegacyKeys(legacyKeys: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    legacyKeys.forEach((key) => window.localStorage.removeItem(key));
  } catch {}
}

function subscribePreference(
  listeners: Set<() => void>,
  keys: string[],
  listener: () => void,
) {
  listeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }

  const handleStorage = (event: StorageEvent) => {
    if (!event.key || keys.includes(event.key)) {
      invalidateStorageValue(keys[0]);
      listener();
    }
  };

  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function readHistoryPreference() {
  return readStorageValue(
    TRUEPEAK_HISTORY_PREFERENCE_KEY,
    LEGACY_HISTORY_PREFERENCE_KEYS,
  ) === "true";
}

export function subscribeHistoryPreference(listener: () => void) {
  return subscribePreference(
    historyPreferenceListeners,
    [TRUEPEAK_HISTORY_PREFERENCE_KEY, ...LEGACY_HISTORY_PREFERENCE_KEYS],
    listener,
  );
}

export function writeHistoryPreference(value: boolean) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        TRUEPEAK_HISTORY_PREFERENCE_KEY,
        value ? "true" : "false",
      );
      clearLegacyKeys(LEGACY_HISTORY_PREFERENCE_KEYS);
    } catch {}
  }

  invalidateStorageValue(TRUEPEAK_HISTORY_PREFERENCE_KEY);
  historyPreferenceListeners.forEach((listener) => listener());
}

export function readUiModePreference(): WorkspaceUiMode {
  return readStorageValue(
    TRUEPEAK_UI_MODE_PREFERENCE_KEY,
    LEGACY_UI_MODE_PREFERENCE_KEYS,
  ) === "advanced"
    ? "advanced"
    : "simple";
}

export function subscribeUiModePreference(listener: () => void) {
  return subscribePreference(
    uiModePreferenceListeners,
    [TRUEPEAK_UI_MODE_PREFERENCE_KEY, ...LEGACY_UI_MODE_PREFERENCE_KEYS],
    listener,
  );
}

export function writeUiModePreference(value: WorkspaceUiMode) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TRUEPEAK_UI_MODE_PREFERENCE_KEY, value);
      clearLegacyKeys(LEGACY_UI_MODE_PREFERENCE_KEYS);
    } catch {}
  }

  invalidateStorageValue(TRUEPEAK_UI_MODE_PREFERENCE_KEY);
  uiModePreferenceListeners.forEach((listener) => listener());
}

export function readParallelPreference(): ParallelLanesPreference {
  const value = readStorageValue(TRUEPEAK_PARALLEL_PREFERENCE_KEY, []);
  return value === "1" || value === "2" || value === "4" ? value : "auto";
}

export function subscribeParallelPreference(listener: () => void) {
  return subscribePreference(
    parallelPreferenceListeners,
    [TRUEPEAK_PARALLEL_PREFERENCE_KEY],
    listener,
  );
}

export function writeParallelPreference(value: ParallelLanesPreference) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(TRUEPEAK_PARALLEL_PREFERENCE_KEY, value);
    } catch {}
  }

  invalidateStorageValue(TRUEPEAK_PARALLEL_PREFERENCE_KEY);
  parallelPreferenceListeners.forEach((listener) => listener());
}

export function readAnalysisSettingsPreference(): WorkspaceAnalysisSettings | null {
  const raw = readStorageValue(TRUEPEAK_ANALYSIS_SETTINGS_KEY, []);
  if (!raw) {
    return null;
  }

  try {
    return normalizeAnalysisSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function subscribeAnalysisSettingsPreference(listener: () => void) {
  return subscribePreference(
    analysisSettingsListeners,
    [TRUEPEAK_ANALYSIS_SETTINGS_KEY],
    listener,
  );
}

export function writeAnalysisSettingsPreference(settings: WorkspaceAnalysisSettings) {
  let committed = false;
  if (typeof window !== "undefined") {
    try {
      const envelope: WorkspaceAnalysisSettingsEnvelope = {
        version: ANALYSIS_SETTINGS_VERSION,
        settings,
      };
      window.localStorage.setItem(TRUEPEAK_ANALYSIS_SETTINGS_KEY, JSON.stringify(envelope));
      committed = true;
    } catch {
      // Analysis remains available when storage is unavailable.
    }
  }

  invalidateStorageValue(TRUEPEAK_ANALYSIS_SETTINGS_KEY);
  analysisSettingsListeners.forEach((listener) => listener());
  return committed;
}

function systemTheme(): WorkspaceTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year
const THEME_COOKIE_PATTERN = new RegExp(
  `(?:^|;\\s*)${TRUEPEAK_THEME_PREFERENCE_KEY}=(light|dark)(?:;|$)`,
);

let themeCache: WorkspaceTheme | null = null;

function readThemeCookie(): WorkspaceTheme | null {
  if (typeof document === "undefined") {
    return null;
  }

  const match = document.cookie.match(THEME_COOKIE_PATTERN);
  return match ? (match[1] as WorkspaceTheme) : null;
}

export function readThemePreference(): WorkspaceTheme {
  if (typeof window === "undefined") {
    return "dark";
  }

  // The theme lives in a cookie so the server can read it and render the correct
  // data-theme on the first byte (no flash). Fall back to the OS preference if unset.
  themeCache ??= readThemeCookie() ?? systemTheme();
  return themeCache;
}

export function subscribeThemePreference(listener: () => void) {
  themePreferenceListeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      themePreferenceListeners.delete(listener);
    };
  }

  const media =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : null;
  const handleMedia = () => {
    themeCache = null;
    listener();
  };
  media?.addEventListener?.("change", handleMedia);

  return () => {
    themePreferenceListeners.delete(listener);
    media?.removeEventListener?.("change", handleMedia);
  };
}

export function writeThemePreference(value: WorkspaceTheme) {
  if (typeof document !== "undefined") {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${TRUEPEAK_THEME_PREFERENCE_KEY}=${value}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax${secure}`;
  }

  themeCache = null;
  themePreferenceListeners.forEach((listener) => listener());
}
