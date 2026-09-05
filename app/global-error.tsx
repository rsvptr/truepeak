"use client";

import { useEffect } from "react";

// Root-layout crash screen. Next renders this in place of the whole document
// when RootLayout itself throws, so it must supply its own <html>/<body> and
// cannot depend on anything the layout provides (fonts, cookies, globals.css).
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#071412",
          color: "#f6faf8",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>Something went wrong</h1>
          <p style={{ marginTop: 12, fontSize: "0.875rem", lineHeight: 1.5, opacity: 0.8 }}>
            The application hit an unexpected error and stopped. If local recovery storage
            was available and its latest write completed, finished results should return
            after a reload. You can try again now, or reload the page if it keeps happening.
          </p>
          <div style={{ marginTop: 20, display: "flex", justifyContent: "center", gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #1c3330",
                background: "#0e211e",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #1c3330",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              Reload the page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
