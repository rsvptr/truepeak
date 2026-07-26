import Link from "next/link";
import { TruePeakLogo } from "@/components/truepeak-logo";

export default function NotFound() {
  return (
    <main className="tp-min-h-viewport mx-auto flex w-full max-w-[2048px] items-center justify-center px-4 py-6 sm:px-6 xl:px-10 2xl:px-12">
      <div className="w-full max-w-[460px] rounded-[28px] border border-[var(--line)] bg-[var(--surface-1)] px-6 py-6 shadow-[var(--shadow-elevated)]">
        <h1 className="sr-only">Page not found</h1>
        <TruePeakLogo size="sm" subtitle="Page not found" />
        <p className="mt-4 text-sm leading-6 text-[var(--muted)]">
          There is nothing at this address. The analyzer lives on the home page.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-full border border-transparent bg-[var(--accent-strong)] px-4 text-xs font-semibold text-[var(--surface-0)] shadow-sm transition-[background-color,box-shadow] duration-200 ease-out hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]"
        >
          Back to the analyzer
        </Link>
      </div>
    </main>
  );
}
