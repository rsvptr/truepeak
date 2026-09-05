"use client";

import { useSyncExternalStore } from "react";

// Hydration-safe media-query store (UX-033, MOB-15). A useState+useEffect
// version initializes `false` and only corrects after mount, so the first
// client render can briefly take the wrong branch (e.g. a desktop deep link
// mounting the mobile/modal path before switching to inline layout). A
// useSyncExternalStore store reads matchMedia during render (matching the
// committed DOM), shares one subscription per query, and reports `false` on
// the server for a stable SSR snapshot.
const mediaQueryStores = new Map<
  string,
  { subscribe: (onChange: () => void) => () => void; getSnapshot: () => boolean }
>();

function getMediaQueryStore(query: string) {
  let store = mediaQueryStores.get(query);
  if (!store) {
    let mediaQuery: MediaQueryList | null = null;
    const resolve = () => {
      if (mediaQuery == null && typeof window !== "undefined" && typeof window.matchMedia === "function") {
        mediaQuery = window.matchMedia(query);
      }
      return mediaQuery;
    };
    store = {
      subscribe: (onChange: () => void) => {
        const media = resolve();
        if (!media) {
          return () => {};
        }
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
      },
      getSnapshot: () => resolve()?.matches ?? false,
    };
    mediaQueryStores.set(query, store);
  }
  return store;
}

const getMediaQueryServerSnapshot = () => false;

export function useMediaQuery(query: string) {
  const store = getMediaQueryStore(query);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getMediaQueryServerSnapshot);
}
