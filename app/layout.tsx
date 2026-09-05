import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { Telemetry } from "@/components/telemetry";
import "./globals.css";

const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600"],
});

// Telemetry defaults to off. A deployment operator must both deploy on Vercel
// and explicitly opt in with NEXT_PUBLIC_ENABLE_TELEMETRY=1; without that flag,
// no Analytics or Speed Insights script loads, hosted or not.
const enableVercelInsights =
  process.env.VERCEL === "1" && process.env.NEXT_PUBLIC_ENABLE_TELEMETRY === "1";

const APP_DESCRIPTION =
  "Loudness and true peak analysis in your browser, for mastering, delivery checks, and quick file review.";

// Forks and self-hosted deployments should get OG/canonical URLs that point at
// their own origin, not the original author's. Prefer an explicit site URL,
// fall back to Vercel's auto-injected deployment URL (unprefixed on purpose:
// it is read at build/request time on the server, never shipped to the
// client), and only fall back to the canonical deployment as a last resort.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ??
  "https://true-peak.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "TruePeak",
  description: APP_DESCRIPTION,
  applicationName: "TruePeak",
  category: "music",
  keywords: ["TruePeak", "LUFS", "loudness", "true peak", "R128", "audio analysis", "mastering"],
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "TruePeak",
    description: APP_DESCRIPTION,
    url: "/",
    siteName: "TruePeak",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TruePeak",
    description: APP_DESCRIPTION,
  },
};

export function generateViewport(): Viewport {
  // Match the browser UI (address bar, status bar) to the active theme, and
  // extend the layout into notch/home-indicator areas so the safe-area
  // padding in globals.css can take over.
  // Media-qualified colors keep the static shell aligned with the OS before
  // the pre-paint script resolves a saved choice. The client mutates these
  // React-owned tags in place after a theme toggle.
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: "#f6faf8" },
      { media: "(prefers-color-scheme: dark)", color: "#071412" },
    ],
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable}`}>
        {/* Pre-paint theme correction: the static shell ships with data-theme="dark" and no
            server ever reads the cookie, so first-time visitors whose OS prefers light would
            otherwise see a dark flash before React applies their preference.
            Runs before anything renders; cookie still wins when present. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=document.cookie.match(/(?:^|;\\s*)truepeak-theme=(light|dark)(?:;|$)/);var t=m?m[1]:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=t;}catch(e){}})();",
          }}
        />
        {children}
        {enableVercelInsights ? <Telemetry /> : null}
      </body>
    </html>
  );
}
