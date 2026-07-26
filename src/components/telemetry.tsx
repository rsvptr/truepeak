"use client";

import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

// Workspace state lives in the query string, and three of those params carry
// user content: `search` is the queue search box, which matches against local
// audio filenames, while `job` and `reference` are session-local ids. Both
// telemetry SDKs report the full href, so without this an opted-in deployment
// would receive filename fragments from the visitor's own machine. The pathname
// and the enum-valued workspace params are all the analytics needs.
const STRIPPED_PARAMS = ["search", "job", "reference"];

function scrubUrl<Event extends { url: string }>(event: Event): Event | null {
  try {
    const url = new URL(event.url);
    let changed = false;
    for (const param of STRIPPED_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        changed = true;
      }
    }
    return changed ? { ...event, url: url.toString() } : event;
  } catch {
    // Both SDKs treat a null return as "drop this event". A url that cannot be
    // parsed cannot be scrubbed either, so dropping is the only safe answer.
    return null;
  }
}

/**
 * Client boundary for the optional Vercel telemetry.
 *
 * `beforeSend` is a function, and functions cannot cross the server-to-client
 * boundary, so the root layout (a Server Component, it reads the theme cookie)
 * cannot pass one to <Analytics>. Mounting both integrations from inside a
 * client component keeps the scrubber on the client side of that line.
 */
export function Telemetry() {
  return (
    <>
      <Analytics beforeSend={scrubUrl} />
      <SpeedInsights beforeSend={scrubUrl} />
    </>
  );
}
