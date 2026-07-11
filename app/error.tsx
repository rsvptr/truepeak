"use client";

import { useEffect } from "react";
import { TruePeakLogo } from "@/components/truepeak-logo";
import { Button } from "@/components/ui/button";

// Styled recovery screen for uncaught render errors. Without it, a crash in
// the client tree drops the user onto Next's bare default error page with no
// way back into the session.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[2048px] items-center justify-center px-4 py-6 sm:px-6 xl:px-10 2xl:px-12">
      <div className="w-full max-w-[520px] rounded-[28px] border border-[var(--line)] bg-[var(--surface-1)] px-6 py-6 shadow-[var(--shadow-elevated)]">
        <TruePeakLogo size="sm" subtitle="Something went wrong" />
        <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
          The workspace hit an unexpected error and stopped. Your completed results are
          saved in this browser and come back after a reload. You can try again right
          away, or reload the page if it keeps happening.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={reset}>
            Try again
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </div>
      </div>
    </div>
  );
}
