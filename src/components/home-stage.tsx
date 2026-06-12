"use client";

import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Settings2,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import { formatLufs, formatPeakDbtp } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ParallelLanesPreference } from "@/lib/workspace-preferences";
import type { AnalysisMode, DecodePreference, TargetPreset } from "@/types/audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface DecodeOption {
  id: DecodePreference;
  label: string;
  description: string;
}

interface HomeStageProps {
  uiMode: "simple" | "advanced";
  analysisMode: AnalysisMode;
  decodePreference: DecodePreference;
  parallelPreference: ParallelLanesPreference;
  resolvedParallelLimit: number;
  currentTarget: TargetPreset | null;
  currentModeLabel: string;
  supportedFormats: string[];
  decodeOptions: DecodeOption[];
  isDragging: boolean;
  onOpenPicker: () => void;
  onSetUiMode: (mode: "simple" | "advanced") => void;
  onSetAnalysisMode: (mode: AnalysisMode) => void;
  onSetDecodePreference: (preference: DecodePreference) => void;
  onSetParallelPreference: (preference: ParallelLanesPreference) => void;
  onOpenPresetLibrary: () => void;
}

const PARALLEL_OPTIONS: Array<{ id: ParallelLanesPreference; label: string }> = [
  { id: "auto", label: "Auto (recommended)" },
  { id: "1", label: "1 file at a time" },
  { id: "2", label: "2 files at once" },
  { id: "4", label: "4 files at once" },
];

function ToggleButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] items-center justify-center rounded-[14px] px-3 py-2 text-sm font-semibold transition-[background-color,color,box-shadow] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        active
          ? "bg-[color:var(--accent-soft)] text-[var(--ink)] shadow-[0_10px_24px_rgba(18,141,129,0.12)]"
          : "text-[var(--muted)] hover:text-[var(--ink)]",
      )}
    >
      {children}
    </button>
  );
}

function SupportNote({ children }: { children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span
        className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_14px_rgba(62,209,189,0.45)]"
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

function StripSection({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex h-full min-h-[148px] flex-col rounded-[22px] border border-[var(--line)]/65 bg-[var(--surface-0)]/58 px-5 py-4",
        className,
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-3 flex flex-1 flex-col">{children}</div>
    </section>
  );
}

export function HomeStage({
  uiMode,
  analysisMode,
  decodePreference,
  parallelPreference,
  resolvedParallelLimit,
  currentTarget,
  currentModeLabel,
  supportedFormats,
  decodeOptions,
  isDragging,
  onOpenPicker,
  onSetUiMode,
  onSetAnalysisMode,
  onSetDecodePreference,
  onSetParallelPreference,
  onOpenPresetLibrary,
}: HomeStageProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedPanelId = "home-stage-advanced-options";
  const decodeOption =
    decodeOptions.find((option) => option.id === decodePreference) ?? decodeOptions[0];

  return (
    <Card className="tp-enter overflow-hidden border-[color:var(--accent)]/10 bg-[var(--surface-0)] p-0 shadow-[0_28px_72px_rgba(0,0,0,0.16)]">
      <div className="relative isolate overflow-hidden rounded-[34px]">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(62,209,189,0.08),transparent_38%,rgba(247,183,86,0.04))]" />

        <div className="relative px-6 py-6 sm:px-7 sm:py-7 xl:px-8 xl:py-8">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{currentModeLabel}</Badge>
            <Badge className="border-[var(--line)]/80 bg-[var(--surface-1)]/74 text-[var(--muted)]">
              {uiMode === "simple" ? "Simple workflow" : "Advanced workflow"}
            </Badge>
          </div>

          <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1.34fr)_minmax(300px,0.66fr)] xl:items-stretch">
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                Start here
              </div>
              <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--ink)] sm:text-4xl xl:text-[3.45rem] xl:leading-[1.02]">
                Choose your files and start the review
              </h2>
              <p className="mt-4 max-w-[68ch] text-sm leading-7 text-[var(--muted)] sm:text-base">
                Pick the working style, decide whether you want a target, then add audio. The results view opens right away so the table, charts, and file details have room to breathe.
              </p>
            </div>

            <div className="flex min-h-[178px] h-full flex-col justify-between rounded-[24px] border border-[var(--line)]/60 bg-[var(--surface-1)]/38 px-5 py-5 text-sm leading-6 text-[var(--muted)]">
              <p>
                Everything stays in the browser. As soon as you choose files, the review view opens and the queue takes over.
              </p>
              <div className="mt-5 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                <span className="rounded-full border border-[var(--line)]/70 bg-[var(--surface-0)]/54 px-3 py-1.5">
                  Opens results view
                </span>
                <span className="rounded-full border border-[var(--line)]/70 bg-[var(--surface-0)]/54 px-3 py-1.5">
                  Browser processing
                </span>
              </div>
            </div>
          </div>

          <div className="mt-7 rounded-[30px] border border-[var(--line)]/72 bg-[var(--surface-1)]/52 px-6 py-6 sm:px-7 sm:py-7">
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] xl:items-stretch">
              <section
                aria-label="Drag and drop area"
                className={cn(
                  "rounded-[24px] border border-dashed px-5 py-5 transition-[background-color,border-color,box-shadow] duration-200 ease-out",
                  isDragging
                    ? "border-[color:var(--accent)] bg-[color:var(--accent-soft)] shadow-[0_22px_54px_rgba(18,141,129,0.18)]"
                    : "border-[var(--line)]/72 bg-[var(--surface-0)]/22",
                )}
              >
                <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                  <Upload className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                  Drag and drop
                </div>
                <h3 className="mt-3 text-2xl font-semibold text-[var(--ink)] sm:text-3xl">
                  Drop files or folders anywhere
                </h3>
                <p className="mt-3 max-w-[60ch] text-sm leading-7 text-[var(--muted)] sm:text-base">
                  Drag a batch — or a whole album folder — onto any part of the app. Folders are scanned for supported audio, and the session opens as soon as the files are accepted.
                </p>
                <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--line)]/70 bg-[var(--surface-0)]/54 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                  Works on every screen, folders included
                </div>
              </section>

              <div className="flex min-h-[168px] h-full flex-col justify-between gap-4 xl:pl-2">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                    Browse files
                  </div>
                  <p className="mt-3 max-w-[34ch] text-sm leading-6 text-[var(--muted)]">
                    Prefer the file picker? Use the button below and the app will move straight into the review screen.
                  </p>
                </div>
                <Button
                  type="button"
                  size="lg"
                  className="min-h-[56px] w-full justify-center text-center shadow-[0_18px_44px_rgba(18,141,129,0.24)]"
                  onClick={onOpenPicker}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Select Audio Files
                </Button>
                <ul className="grid gap-2 text-xs leading-5 text-[var(--muted)]">
                  <SupportNote>Browser decode where available</SupportNote>
                  <SupportNote>Review aid, not a certified compliance meter</SupportNote>
                  <SupportNote>{`Supports ${supportedFormats.join(", ")}`}</SupportNote>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-[24px] border border-[var(--line)]/70 bg-[var(--surface-1)]/54 p-3 sm:p-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 xl:items-stretch">
              <StripSection label="Workspace mode">
                <div className="flex h-full flex-col justify-between gap-4">
                  <div className="grid grid-cols-2 gap-2 rounded-[18px] border border-[var(--line)] bg-[var(--surface-1)]/78 p-1" role="group" aria-label="Choose workspace mode">
                    <ToggleButton active={uiMode === "simple"} onClick={() => onSetUiMode("simple")}>
                      Simple
                    </ToggleButton>
                    <ToggleButton active={uiMode === "advanced"} onClick={() => onSetUiMode("advanced")}>
                      Advanced
                    </ToggleButton>
                  </div>
                  <p className="text-sm leading-6 text-[var(--muted)]">
                    Simple keeps the table at the centre. Advanced adds compare, insights, and deeper controls.
                  </p>
                </div>
              </StripSection>

              <StripSection label="Analysis mode">
                <div className="flex h-full flex-col justify-between gap-4">
                  <div className="grid grid-cols-2 gap-2 rounded-[18px] border border-[var(--line)] bg-[var(--surface-1)]/78 p-1" role="group" aria-label="Choose analysis mode">
                    <ToggleButton active={analysisMode === "targeted"} onClick={() => onSetAnalysisMode("targeted")}>
                      Targeted
                    </ToggleButton>
                    <ToggleButton active={analysisMode === "measure-only"} onClick={() => onSetAnalysisMode("measure-only")}>
                      Measure Only
                    </ToggleButton>
                  </div>
                  <p className="text-sm leading-6 text-[var(--muted)]">
                    {analysisMode === "targeted"
                      ? "Keep a preset active when you want target delta, projected peak, and compliance guidance."
                      : "Show measured loudness, peaks, dynamics, and timeline data without applying a target."}
                  </p>
                </div>
              </StripSection>

              <StripSection
                label={analysisMode === "targeted" && currentTarget ? "Current preset" : "Mode"}
              >
                {analysisMode === "targeted" && currentTarget ? (
                  <div className="flex h-full flex-col justify-between gap-4">
                    <div>
                      <div className="text-base font-semibold text-[var(--ink)]">{currentTarget.label}</div>
                      <div className="mt-1 text-sm text-[var(--muted)]">
                        {formatLufs(currentTarget.loudnessTargetLufs)} / {formatPeakDbtp(currentTarget.truePeakCeilingDbtp)}
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="secondary" className="w-full justify-center" onClick={onOpenPresetLibrary}>
                      <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
                      Preset Library
                    </Button>
                  </div>
                ) : (
                  <div className="flex h-full flex-col justify-between gap-4">
                    <div>
                      <div className="text-base font-semibold text-[var(--ink)]">Raw measurement</div>
                      <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                        The app will show loudness, peaks, dynamics, and timing as measured. No target or gain plan is active.
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                      Target presets are off
                    </div>
                  </div>
                )}
              </StripSection>

              <StripSection label="Advanced" className="justify-between">
                <div className="flex h-full flex-col justify-between gap-4">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-11 w-full justify-between rounded-[18px] border border-[var(--line)] bg-[var(--surface-0)]/58 px-4 text-[var(--ink)]"
                    aria-expanded={advancedOpen}
                    aria-controls={advancedPanelId}
                    onClick={() => setAdvancedOpen((current) => !current)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Settings2 className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
                      Advanced options
                    </span>
                    {advancedOpen ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                  <p className="text-sm leading-6 text-[var(--muted)]">
                    Override the default decode path only when you need to.
                  </p>
                </div>
              </StripSection>
            </div>

            {advancedOpen ? (
              <div id={advancedPanelId} className="tp-enter-soft mt-4 grid gap-3 border-t border-[var(--line)]/70 pt-4 lg:grid-cols-3">
                <StripSection label="Decode path" className="min-h-[140px]">
                  <div className="flex h-full flex-col justify-between gap-4">
                    <label htmlFor="decode-preference" className="block text-sm text-[var(--muted)]">
                      <span className="sr-only">Preferred decode path</span>
                      <select
                        id="decode-preference"
                        name="decode-preference"
                        aria-label="Choose decode path"
                        value={decodePreference}
                        onChange={(event) => onSetDecodePreference(event.target.value as DecodePreference)}
                        className="h-11 w-full rounded-[18px] border border-[var(--line)] bg-[var(--surface-1)] px-3 text-[var(--ink)] outline-none transition-[border-color,background-color] duration-200 ease-out focus:border-[var(--accent)]"
                      >
                        {decodeOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="text-sm leading-6 text-[var(--muted)]">
                      Choose a preferred decode route when you want to favour speed, browser codecs, or maximum compatibility.
                    </div>
                  </div>
                </StripSection>

                <StripSection label="Parallel files" className="min-h-[140px]">
                  <div className="flex h-full flex-col justify-between gap-4">
                    <label htmlFor="parallel-files" className="block text-sm text-[var(--muted)]">
                      <span className="sr-only">How many files analyze at once</span>
                      <select
                        id="parallel-files"
                        name="parallel-files"
                        aria-label="Choose how many files analyze at once"
                        value={parallelPreference}
                        onChange={(event) => onSetParallelPreference(event.target.value as ParallelLanesPreference)}
                        className="h-11 w-full rounded-[18px] border border-[var(--line)] bg-[var(--surface-1)] px-3 text-[var(--ink)] outline-none transition-[border-color,background-color] duration-200 ease-out focus:border-[var(--accent)]"
                      >
                        {PARALLEL_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="text-sm leading-6 text-[var(--muted)]">
                      {parallelPreference === "auto"
                        ? `Auto picks ${resolvedParallelLimit} for this device. Lower it if the tab feels heavy with very large files.`
                        : "Auto matches the lane count to this device's CPU and memory. Very large files always run alone."}
                    </div>
                  </div>
                </StripSection>

                <StripSection label="Current decode strategy" className="min-h-[140px]">
                  <div className="flex h-full flex-col justify-between gap-4">
                    <div className="text-base font-semibold text-[var(--ink)]">{decodeOption.label}</div>
                    <p className="text-sm leading-6 text-[var(--muted)]">{decodeOption.description}</p>
                  </div>
                </StripSection>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
