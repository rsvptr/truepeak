import type { MetadataRoute } from "next";
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TruePeak",
    short_name: "TruePeak",
    description: "Loudness and true peak analysis in your browser, for mastering, delivery checks, and quick file review.",
    start_url: "/",
    display: "standalone",
    background_color: "#071412",
    theme_color: "#071412",
    icons: [
      {
        src: "/favicon.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/logo.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icon-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
