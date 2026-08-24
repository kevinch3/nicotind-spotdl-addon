import { describe, it, expect } from "bun:test";
import { measureSuccess } from "./measure-success.js";

/**
 * A synthetic multi-job `docker logs` excerpt, in the exact shape
 * `JobStore.log` writes (`[spotdl <jobid>] <spotDL line>`, per issue #651's
 * per-job prefix). Mirrors real kpc jobs measured by hand this session.
 */
function logLine(jobId: string, line: string): string {
  return `[spotdl ${jobId}] ${line}`;
}

describe("measureSuccess", () => {
  it("computes each job's rate from its own announced total, not a flat line count", () => {
    const log = [
      logLine("aaa11111", "Found 3 songs in Mix (Playlist)"),
      logLine("aaa11111", 'Downloaded "A - One": https://y/1'),
      logLine(
        "aaa11111",
        "https://open.spotify.com/track/2 - LookupError: No results found for song: X - Y",
      ),
      logLine(
        "aaa11111",
        "https://open.spotify.com/track/3 - AudioProviderError: YT-DLP download error",
      ),
      logLine("bbb22222", "Found 2 songs in Solo (Song)"),
      logLine("bbb22222", 'Downloaded "B - Two": https://y/2'),
      logLine("bbb22222", 'Skipping B - Three (file already exists) https://y/3'),
    ].join("\n");

    const report = measureSuccess(log);

    expect(report.jobs).toEqual([
      { jobId: "aaa11111", title: "Mix", expected: 3, downloaded: 1, rate: 1 / 3 },
      { jobId: "bbb22222", title: "Solo", expected: 2, downloaded: 2, rate: 1 },
    ]);
    expect(report.totalTracks).toBe(5);
    expect(report.totalDownloaded).toBe(3);
    expect(report.rate).toBeCloseTo(3 / 5);
  });

  it("counts a resumed skip (file already on disk) as landed, same as JobStore does", () => {
    const log = [
      logLine("ccc33333", "Found 1 songs in Solo (Song)"),
      logLine("ccc33333", "Skipping explicit song: C - Four"),
    ].join("\n");
    expect(measureSuccess(log).jobs[0]).toMatchObject({ downloaded: 1, expected: 1 });
  });

  it("a job that crashed before announcing a total contributes zero, not NaN", () => {
    const log = [
      logLine("ddd44444", "╭─── Traceback (most recent call last) ───╮"),
      logLine("ddd44444", "JSONDecodeError: Expecting value: line 1 column 1 (char 0)"),
    ].join("\n");
    const report = measureSuccess(log);
    expect(report.jobs).toEqual([
      { jobId: "ddd44444", title: null, expected: 0, downloaded: 0, rate: 0 },
    ]);
    expect(report.totalTracks).toBe(0);
    expect(report.rate).toBe(0);
  });

  it("a retry pass's own announcement (issue #651 item C) never overwrites the job's real total", () => {
    // A batched retry pass re-invoking spotDL for a couple of specific tracks
    // could itself print a "Found N songs" line for that smaller ad hoc
    // batch — under the SAME [spotdl <jobid>] prefix, since JobStore logs
    // every pass under the original job id. The FIRST total is the real one.
    const log = [
      logLine("eee55555", "Found 10 songs in Big (Playlist)"),
      logLine("eee55555", 'Downloaded "E - One": https://y/1'),
      logLine("eee55555", "https://t/2 - JSONDecodeError: Expecting value: line 1 column 1 (char 0)"),
      // Retry pass, same job id, a much smaller apparent "total".
      logLine("eee55555", "Found 1 songs in E - Two (Song)"),
      logLine("eee55555", 'Downloaded "E - Two": https://y/2'),
    ].join("\n");
    const report = measureSuccess(log);
    expect(report.jobs[0]).toMatchObject({ expected: 10, downloaded: 2 });
  });

  it("returns an empty report for an empty log", () => {
    expect(measureSuccess("")).toEqual({ jobs: [], totalTracks: 0, totalDownloaded: 0, rate: 0 });
  });
});
