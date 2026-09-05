"use client";

import { useSyncExternalStore } from "react";

const subscribeToHydration = () => () => {};

export function useIsHydrated() {
  return useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
}
