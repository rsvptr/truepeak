"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  applyDraft,
  cancelDraft,
  createDefaultTargetState,
  draftStatusMessage,
  isDraftDirty,
  isDraftModified,
  resetToPublished,
  resolveActiveTarget,
  resolveDraftTarget,
  selectPreset,
  serializeCommittedDraft,
  stateFromStoredSettings,
  updateDraft,
  type TargetWorkspaceState,
} from "@/audio/presets";
import {
  readAnalysisSettingsPreference,
  readAnalysisSettingsPreferenceServerSnapshot,
  subscribeAnalysisSettingsPreference,
  writeAnalysisSettingsPreference,
  type WorkspaceAnalysisSettings,
} from "@/lib/workspace-preferences";
import type { AnalysisMode, DecodePreference, TargetPreset } from "@/types/audio";

function readSettingsSnapshot() {
  const settings = readAnalysisSettingsPreference();
  return settings ? JSON.stringify(settings) : "";
}

function readServerSettingsSnapshot() {
  const settings = readAnalysisSettingsPreferenceServerSnapshot();
  return settings ? JSON.stringify(settings) : "";
}

export function useAnalysisSettings() {
  const serializedSettings = useSyncExternalStore(
    subscribeAnalysisSettingsPreference,
    readSettingsSnapshot,
    readServerSettingsSnapshot,
  );
  const storedSettings = useMemo<WorkspaceAnalysisSettings | null>(
    () => serializedSettings ? JSON.parse(serializedSettings) as WorkspaceAnalysisSettings : null,
    [serializedSettings],
  );
  // Key the target on the five fields stateFromStoredSettings reads, so writing
  // the decode preference or analysis mode keeps the same target object and
  // does not retarget (and rescore) every result.
  const hasStoredSettings = storedSettings != null;
  const storedPresetId = storedSettings?.selectedPresetId;
  const storedCustomTargetLufs = storedSettings?.customTargetLufs;
  const storedCustomTruePeak = storedSettings?.customTruePeak;
  const storedTargetTolerance = storedSettings?.targetTolerance;
  const storedCustomPolicy = storedSettings?.customPolicy;
  const storedTargetState = useMemo(
    () => hasStoredSettings
      ? stateFromStoredSettings({
        selectedPresetId: storedPresetId!,
        customTargetLufs: storedCustomTargetLufs!,
        customTruePeak: storedCustomTruePeak!,
        targetTolerance: storedTargetTolerance!,
        customPolicy: storedCustomPolicy!,
      })
      : createDefaultTargetState(),
    [hasStoredSettings, storedPresetId, storedCustomTargetLufs, storedCustomTruePeak, storedTargetTolerance, storedCustomPolicy],
  );
  const [targetOverride, setTargetOverride] = useState<TargetWorkspaceState | null>(null);
  const [analysisModeOverride, setAnalysisModeOverride] = useState<AnalysisMode | null>(null);
  const [decodePreferenceOverride, setDecodePreferenceOverride] = useState<DecodePreference | null>(null);
  const [recoveryWritesAllowed, setRecoveryWritesAllowed] = useState(true);
  const [settingsPersistenceIssue, setSettingsPersistenceIssue] = useState<string | null>(null);

  const targetState = targetOverride ?? storedTargetState;
  const persistedAnalysisMode = analysisModeOverride ?? storedSettings?.analysisMode ?? "targeted";
  const decodePreference = decodePreferenceOverride ?? storedSettings?.decodePreference ?? "auto";

  const persist = useCallback((
    nextTargetState: TargetWorkspaceState,
    nextAnalysisMode: AnalysisMode,
    nextDecodePreference: DecodePreference,
  ) => {
    const committed = writeAnalysisSettingsPreference({
      analysisMode: nextAnalysisMode,
      ...serializeCommittedDraft(nextTargetState.committed),
      decodePreference: nextDecodePreference,
    });
    setRecoveryWritesAllowed(committed);
    setSettingsPersistenceIssue(
      committed
        ? null
        : "TruePeak could not save the active target and decoder settings. New results stay out of browser recovery until settings storage works again.",
    );
    return committed;
  }, []);

  const setPersistedAnalysisMode = useCallback((next: AnalysisMode) => {
    setAnalysisModeOverride(next);
    persist(targetState, next, decodePreference);
  }, [decodePreference, persist, targetState]);

  const setDecodePreference = useCallback((next: DecodePreference) => {
    setDecodePreferenceOverride(next);
    persist(targetState, persistedAnalysisMode, next);
  }, [persist, persistedAnalysisMode, targetState]);

  const handleSelectPreset = useCallback((presetId: string) => {
    const next = selectPreset(targetState, presetId);
    setTargetOverride(next);
    if (next.committed !== targetState.committed) {
      persist(next, persistedAnalysisMode, decodePreference);
    }
  }, [decodePreference, persist, persistedAnalysisMode, targetState]);

  // Draft-only edits never persist, so they derive the next state from the
  // latest one rather than from the render that created the handler.
  const handleToleranceChange = useCallback((value: string) => {
    setTargetOverride((current) => updateDraft(current ?? storedTargetState, { toleranceLufs: value }));
  }, [storedTargetState]);

  const handleCustomTargetLufsChange = useCallback((value: string) => {
    setTargetOverride((current) => updateDraft(current ?? storedTargetState, { customTargetLufs: value }));
  }, [storedTargetState]);

  const handleCustomTruePeakChange = useCallback((value: string) => {
    setTargetOverride((current) => updateDraft(current ?? storedTargetState, { customTruePeak: value }));
  }, [storedTargetState]);

  const handlePolicyChange = useCallback((policy: TargetPreset["policy"]) => {
    setTargetOverride((current) => updateDraft(current ?? storedTargetState, { policy }));
  }, [storedTargetState]);

  const handleApplyDraft = useCallback(() => {
    const next = applyDraft(targetState);
    setTargetOverride(next);
    if (next !== targetState) {
      persist(next, persistedAnalysisMode, decodePreference);
    }
  }, [decodePreference, persist, persistedAnalysisMode, targetState]);

  const handleCancelDraft = useCallback(() => {
    setTargetOverride((current) => cancelDraft(current ?? storedTargetState));
  }, [storedTargetState]);

  const handleResetToPublished = useCallback(() => {
    const next = resetToPublished(targetState);
    setTargetOverride(next);
    if (next !== targetState) {
      persist(next, persistedAnalysisMode, decodePreference);
    }
  }, [decodePreference, persist, persistedAnalysisMode, targetState]);

  const retrySettingsPersistence = useCallback(() => {
    persist(targetState, persistedAnalysisMode, decodePreference);
  }, [decodePreference, persist, persistedAnalysisMode, targetState]);

  const activeTarget = useMemo(
    () => resolveActiveTarget(targetState.committed),
    [targetState.committed],
  );
  const draftResolution = useMemo(
    () => resolveDraftTarget(targetState.draft),
    [targetState.draft],
  );

  return {
    activeTarget,
    decodePreference,
    draftIsDirty: isDraftDirty(targetState),
    draftIsModified: isDraftModified(targetState.draft),
    draftPreviewTarget: draftResolution.target,
    draftResolution,
    draftStatus: draftStatusMessage(targetState),
    handleApplyDraft,
    handleCancelDraft,
    handleCustomTargetLufsChange,
    handleCustomTruePeakChange,
    handlePolicyChange,
    handleResetToPublished,
    handleSelectPreset,
    handleToleranceChange,
    persistedAnalysisMode,
    recoveryWritesAllowed,
    retrySettingsPersistence,
    setDecodePreference,
    setPersistedAnalysisMode,
    settingsPersistenceIssue,
    targetState,
  };
}
