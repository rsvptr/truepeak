"use client";

import { useSyncExternalStore } from "react";

export type ConnectionSavingStatus = "normal" | "save-data" | "slow";

interface ConnectionInformation extends EventTarget {
  effectiveType?: string;
  saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  connection?: ConnectionInformation;
}

function getConnection() {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  return (navigator as NavigatorWithConnection).connection;
}

function getSnapshot(): ConnectionSavingStatus {
  const connection = getConnection();
  if (connection?.saveData) {
    return "save-data";
  }
  if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") {
    return "slow";
  }
  return "normal";
}

function subscribe(onStoreChange: () => void) {
  const connection = getConnection();
  connection?.addEventListener("change", onStoreChange);
  return () => connection?.removeEventListener("change", onStoreChange);
}

export function useConnectionSavingStatus() {
  return useSyncExternalStore<ConnectionSavingStatus>(
    subscribe,
    getSnapshot,
    () => "normal",
  );
}
