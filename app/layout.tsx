import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { IBM_Plex_Mono, Space_Grotesk } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";
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
  icons: {
    icon: [
      { url: "/favicon.png", type: "image/png", sizes: "192x192" },
      { url: "/logo.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/favicon.png", type: "image/png", sizes: "192x192" }],
    shortcut: ["/favicon.png"],
  },
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

export async function generateViewport(): Promise<Viewport> {
  // Match the browser UI (address bar, status bar) to the active theme, and
  // extend the layout into notch/home-indicator areas so the safe-area
  // padding in globals.css can take over.
  const themeCookie = (await cookies()).get("truepeak-theme")?.value;
  if (themeCookie === "light" || themeCookie === "dark") {
    return {
      width: "device-width",
      initialScale: 1,
      viewportFit: "cover",
      themeColor: themeCookie === "light" ? "#f6faf8" : "#071412",
    };
  }

  // No stored choice yet: emit both media-qualified colors so first-time
  // visitors get browser chrome that matches the OS preference the pre-paint
  // script will apply. The client keeps this meta in sync after any toggle.
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: [
      { media: "(prefers-color-scheme: light)", color: "#f6faf8" },
      { media: "(prefers-color-scheme: dark)", color: "#071412" },
    ],
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Read the theme from the cookie so the server renders the correct data-theme on the
  // first byte, with no flash of the default theme for users who chose light mode.
  const themeCookie = (await cookies()).get("truepeak-theme")?.value;
  const theme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : "dark";
  return (
    <html lang="en" data-theme={theme} suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable}`}>
        {/* Pre-paint theme correction: the server defaults to dark when no
            cookie is set, so first-time visitors whose OS prefers light would
            otherwise see a dark flash before React applies their preference.
            Runs before anything renders; cookie still wins when present. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var m=document.cookie.match(/(?:^|;\\s*)truepeak-theme=(light|dark)(?:;|$)/);var t=m?m[1]:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=t;}catch(e){}})();",
          }}
        />
        {children}
        {enableVercelInsights ? (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        ) : null}
      </body>
    </html>
  );
}
