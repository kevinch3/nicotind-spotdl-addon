#!/usr/bin/env bun
/**
 * The real per-job success rate, from raw `docker logs` text — the same
 * methodology this session ran by hand three times against kpc for issue
 * #651, now a real script (item E) instead of a one-off `grep -oE | uniq -c`.
 *
 * `JobStore.log` (`job-store.ts`) prefixes every spotDL line with
 * `[spotdl <jobid>]`, including every retry pass (issue #651 items A and C
 * both reuse the same job id for a preflight retry / a bounded per-track
 * retry). A flat window-wide `grep -c` over error strings double-counts: a
 * track that failed once, got retried, and succeeded still shows up as one
 * failure line in the count even though the job ultimately delivered it —
 * this session measured that gap directly (a naive 3.2% against the honest
 * 9.0%, same log window). The fix is to fold per job, using each job's own
 * *first* "Found N songs" line as the denominator, not a line count.
 */

import { parseSpotdlPlaylistTitle, parseSpotdlProgress, parseSpotdlTrackEvent } from "@nicotind/addon-sdk";

export interface JobMeasurement {
  jobId: string;
  title: string | null;
  /** From this job's own first "Found N songs" line. 0 if it never got that far
   *  (a whole-job crash before spotDL announced anything — issue #651 item A). */
  expected: number;
  /** Distinct tracks that landed — `Downloaded` or a resumed `Skipping`, deduped
   *  by title so a track spotDL mentions more than once (mid-run, then again in
   *  the `--print-errors` summary, or across a retry pass) is counted once. */
  downloaded: number;
  /** `downloaded / expected`, or 0 when `expected` is 0 (never NaN). */
  rate: number;
}

export interface MeasurementReport {
  jobs: JobMeasurement[];
  totalTracks: number;
  totalDownloaded: number;
  rate: number;
}

interface JobAccumulator {
  jobId: string;
  title: string | null;
  expected: number;
  landed: Set<string>;
}

/**
 * Extract the announced total from one line, stateless — unlike
 * `parseSpotdlProgress`'s own fold (which *overwrites* the running total on
 * every "Found N songs" line it sees), a retry pass re-invoking spotDL for a
 * handful of specific tracks can print its own smaller "Found N songs" under
 * the SAME job id, and that must never clobber the job's real total.
 */
function announcedTotal(line: string): number | null {
  const probe = parseSpotdlProgress(line, { done: 0, total: 0 });
  return probe.total > 0 ? probe.total : null;
}

export function measureSuccess(logText: string): MeasurementReport {
  const byJob = new Map<string, JobAccumulator>();
  const order: string[] = [];

  for (const raw of logText.split("\n")) {
    const match = /^\[spotdl ([a-zA-Z0-9]+)\]\s?(.*)$/.exec(raw);
    if (!match) continue;
    const jobId = match[1]!;
    const line = match[2]!;

    let acc = byJob.get(jobId);
    if (!acc) {
      acc = { jobId, title: null, expected: 0, landed: new Set() };
      byJob.set(jobId, acc);
      order.push(jobId);
    }

    if (acc.expected === 0) {
      const total = announcedTotal(line);
      if (total !== null) acc.expected = total;
    }
    if (acc.title === null) {
      const title = parseSpotdlPlaylistTitle(line);
      if (title) acc.title = title;
    }

    const event = parseSpotdlTrackEvent(line);
    if (event && event.status !== "failed") acc.landed.add(event.title);
  }

  const jobs: JobMeasurement[] = order.map((jobId) => {
    const acc = byJob.get(jobId)!;
    const downloaded = acc.landed.size;
    return {
      jobId,
      title: acc.title,
      expected: acc.expected,
      downloaded,
      rate: acc.expected > 0 ? downloaded / acc.expected : 0,
    };
  });

  const totalTracks = jobs.reduce((n, j) => n + j.expected, 0);
  const totalDownloaded = jobs.reduce((n, j) => n + j.downloaded, 0);
  return {
    jobs,
    totalTracks,
    totalDownloaded,
    rate: totalTracks > 0 ? totalDownloaded / totalTracks : 0,
  };
}

if (import.meta.main) {
  const text = await Bun.stdin.text();
  const report = measureSuccess(text);
  for (const j of report.jobs) {
    const pct = (j.rate * 100).toFixed(1);
    console.log(`${j.jobId}  ${String(j.downloaded).padStart(4)} of ${String(j.expected).padEnd(4)}  ${pct}%  ${j.title ?? "(crashed before a total was announced)"}`);
  }
  console.log("---");
  console.log(
    `${report.totalDownloaded} of ${report.totalTracks} tracks across ${report.jobs.length} job(s) — ${(report.rate * 100).toFixed(1)}%`,
  );
}
