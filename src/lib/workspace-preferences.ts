export type WorkspaceUiMode = "simple" | "advanced";
export type WorkspaceTheme = "light" | "dark";
export type ParallelLanesPreference = "auto" | "1" | "2" | "4";

const TRUEPEAK_HISTORY_PREFERENCE_KEY = "truepeak-history-enabled";
const LEGACY_HISTORY_PREFERENCE_KEYS = ["lufs-history-enabled"];
const TRUEPEAK_UI_MODE_PREFERENCE_KEY = "truepeak-ui-mode";
const LEGACY_UI_MODE_PREFERENCE_KEYS = ["lufs-ui-mode"];
const TRUEPEAK_THEME_PREFERENCE_KEY = "truepeak-theme";
const TRUEPEAK_PARALLEL_PREFERENCE_KEY = "truepeak-parallel-lanes";

const historyPreferenceListeners = new Set<() => void>();
const uiModePreferenceListeners = new Set<() => void>();
const themePreferenceListeners = new Set<() => void>();
const parallelPreferenceListeners = new Set<() => void>();

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
