"use client";

import { useEffect, useRef, useState } from "react";
import { buildBatchIdleAnnouncement } from "@/lib/job-ui";
import { isActiveJob } from "@/lib/session-selectors";
import type { AnalysisJob } from "@/types/audio";

export function useCompletionAnnouncer(jobs: AnalysisJob[]) {
  const [announcement, setAnnouncement] = useState("");
  const announcedBatchIdsRef = useRef(new Set<string>());
  const batchWasActiveRef = useRef(false);

  useEffect(() => {
    if (!jobs.length) {
      announcedBatchIdsRef.current = new Set();
      batchWasActiveRef.current = false;
      setAnnouncement("");
      return;
    }

    const activeJobs = jobs.filter(isActiveJob);
    if (activeJobs.length) {
      activeJobs.forEach((job) => announcedBatchIdsRef.current.add(job.id));
      batchWasActiveRef.current = true;
      setAnnouncement("");
      return;
    }

    if (!batchWasActiveRef.current) {
      return;
    }

    const nextAnnouncement = buildBatchIdleAnnouncement(
      jobs,
      announcedBatchIdsRef.current,
    );
    if (!nextAnnouncement) {
      return;
    }

    setAnnouncement(nextAnnouncement);
    announcedBatchIdsRef.current = new Set();
    batchWasActiveRef.current = false;
  }, [jobs]);

  return announcement;
}
