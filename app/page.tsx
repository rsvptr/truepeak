import { Suspense } from "react";
import { TruePeakWorkbench } from "@/components/truepeak-workbench";
import { TruePeakLogo } from "@/components/truepeak-logo";

function PageFallback() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[2048px] items-center justify-center px-4 py-6 sm:px-6 xl:px-10 2xl:px-12">
      <div className="rounded-[28px] border border-[var(--line)] bg-[var(--surface-1)] px-6 py-5 shadow-[var(--shadow-elevated)]">
        <TruePeakLogo size="sm" subtitle="Loading" />
        <div className="mt-3 text-sm text-[var(--muted)]">Preparing the analyzer...</div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<PageFallback />}>
      <TruePeakWorkbench />
    </Suspense>
  );
}

