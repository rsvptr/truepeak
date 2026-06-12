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

const enableVercelInsights =
  process.env.VERCEL === "1" || process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === "true";

export const metadata: Metadata = {
  title: "TruePeak",
  description:
    "Browser-based loudness and true-peak analysis for mastering, delivery checks, and quick file review.",
  applicationName: "TruePeak",
  category: "music",
  keywords: ["TruePeak", "LUFS", "loudness", "true peak", "R128", "audio analysis", "mastering"],
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.png", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/favicon.png", type: "image/png", sizes: "192x192" }],
    shortcut: ["/favicon.png"],
  },
};

export async function generateViewport(): Promise<Viewport> {
  // Match the browser UI (address bar, status bar) to the active theme, and
  // extend the layout into notch/home-indicator areas so the safe-area
  // padding in globals.css can take over.
  const themeCookie = (await cookies()).get("truepeak-theme")?.value;
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: themeCookie === "light" ? "#f6faf8" : "#071412",
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Read the theme from the cookie so the server renders the correct data-theme on the
  // first byte — no flash of the default theme for users who chose light mode.
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
