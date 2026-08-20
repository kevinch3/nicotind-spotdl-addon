import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  buildArgs,
  DEFAULT_THREADS,
  MAX_THREADS,
  spotifyEnv,
  runSpotdl,
  PLAIN_OUTPUT_ENV,
} from "./resolve.js";

/**
 * A fake spotDL: writes `lines` to stdout (one per chunk, so a line split
 * across reads is exercised too), runs `writeTo` (dropping files into
 * staging), then closes with `code`. Captures the spawn options.
 */
export function fakeSpawn(
  opts: {
    lines?: string[];
    writeTo?: () => void;
    code?: number;
    hang?: boolean;
    /** Hold the process open until this resolves (tests observing mid-run state). */
    gate?: Promise<unknown>;
  } = {},
  capture?: { opts?: unknown; killed?: string },
) {
  return ((_bin: string, _args: string[], spawnOpts?: unknown) => {
    if (capture) capture.opts = spawnOpts;
    const em = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: string | null;
      kill: (sig: string) => boolean;
    };
    em.stdout = new PassThrough();
    em.stderr = new PassThrough();
    em.exitCode = null;
    em.signalCode = null;
    const finish = (code: number | null): void => {
      em.exitCode = code;
      em.stdout.end();
      em.stderr.end();
      em.emit("close", code);
    };
    em.kill = (sig: string) => {
      if (capture) capture.killed = sig;
      em.signalCode = sig;
      queueMicrotask(() => finish(null));
      return true;
    };
    queueMicrotask(() => {
      for (const l of opts.lines ?? []) em.stdout.write(l + "\n");
      opts.writeTo?.();
      if (opts.hang) return;
      if (opts.gate) void opts.gate.then(() => finish(opts.code ?? 0));
      else setTimeout(() => finish(opts.code ?? 0), 5);
    });
    return em;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("buildArgs", () => {
  it("downloads with skip-overwrite, bitrate-disable, and a parseable log", () => {
    const args = buildArgs("https://open.spotify.com/album/x", "/stage", {
      binaryPath: "spotdl",
    });
    expect(args[0]).toBe("download");
    expect(args).toContain("--overwrite");
    expect(args).toContain("skip");
    expect(args.join(" ")).toContain("--bitrate disable");
    // The flags that make stdout carry the playlist name, each track, and the
    // per-song failures (off by default in spotDL).
    expect(args).toContain("--simple-tui");
    expect(args.join(" ")).toContain("--log-level INFO");
    expect(args).toContain("--print-errors");
  });

  it("caps spotDL's own thread pool, defaulting conservatively (issue #601)", () => {
    const def = buildArgs("https://open.spotify.com/album/x", "/stage", {
      binaryPath: "spotdl",
    });
    // Unbounded, spotDL fans out 4 concurrent YouTube fetches per job; stacked
    // across jobs that is what got the deployment rate-limited to ~9% success.
    expect(def.join(" ")).toContain(`--threads ${DEFAULT_THREADS}`);

    const explicit = buildArgs("https://open.spotify.com/album/x", "/stage", {
      binaryPath: "spotdl",
      threads: 1,
    });
    expect(explicit.join(" ")).toContain("--threads 1");
  });

  it("refuses a nonsensical thread count rather than passing it through", () => {
    for (const threads of [0, -3, 99]) {
      const args = buildArgs("https://x", "/stage", {
        binaryPath: "spotdl",
        threads,
      });
      const n = Number(args[args.indexOf("--threads") + 1]);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(MAX_THREADS);
    }
  });
});

describe("spotifyEnv", () => {
  it("is null when creds are absent, and forwards SPOTIPY vars when both set", () => {
    expect(spotifyEnv({ binaryPath: "spotdl" })).toBeNull();
    expect(
      spotifyEnv({ binaryPath: "spotdl", clientId: "a", clientSecret: "" }),
    ).toBeNull();
    const env = spotifyEnv({
      binaryPath: "spotdl",
      clientId: "a",
      clientSecret: "b",
    });
    expect(env).toEqual({ SPOTIPY_CLIENT_ID: "a", SPOTIPY_CLIENT_SECRET: "b" });
  });
});

describe("runSpotdl", () => {
  const stageFor = (tag: string): string =>
    join(tmpdir(), `sp-${process.pid}-${Date.now()}-${tag}`);

  it("streams the title, the total and each track event, then reports the files", async () => {
    const stage = stageFor("run");
    const write = (): void => {
      mkdirSync(join(stage, "Artist", "Album"), { recursive: true });
      writeFileSync(join(stage, "Artist", "Album", "Song.mp3"), "audio-bytes");
    };
    const seen: string[] = [];
    const run = runSpotdl(
      "https://open.spotify.com/playlist/x",
      stage,
      { binaryPath: "spotdl" },
      {
        spawn: fakeSpawn({
          lines: [
            "\x1b[32mFound 3 songs in Summer Mix (Playlist)\x1b[0m",
            'Downloaded "Artist - Song": https://youtu.be/1',
            "Skipping Artist - Other (file already exists) https://open.spotify.com/track/2",
            "https://open.spotify.com/track/3 - LookupError: No results found for song: Artist - Gone",
          ],
          writeTo: write,
          code: 1,
        }),
      },
      {
        onTitle: (t) => seen.push(`title:${t}`),
        onTotal: (n) => seen.push(`total:${n}`),
        onTrack: (e) => seen.push(`${e.status}:${e.title}`),
      },
    );
    const result = await run.done;
    expect(seen).toEqual([
      "title:Summer Mix",
      "total:3",
      "done:Artist - Song",
      "skipped:Artist - Other",
      "failed:Artist - Gone",
    ]);
    expect(result.files.map((f) => f.filename)).toEqual(["Song.mp3"]);
    expect(result.exitCode).toBe(1);
    expect(result.errorLines).toEqual([
      "https://open.spotify.com/track/3 - LookupError: No results found for song: Artist - Gone",
    ]);
  });

  it("spawns with piped output and the plain-output env, creds layered on top", async () => {
    const capture: {
      opts?: { stdio?: unknown; env?: Record<string, string> };
    } = {};
    const run = runSpotdl(
      "https://open.spotify.com/album/x",
      stageFor("env"),
      { binaryPath: "spotdl", clientId: "id", clientSecret: "secret" },
      { spawn: fakeSpawn({}, capture) },
    );
    await run.done;
    expect(capture.opts?.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(capture.opts?.env).toMatchObject({
      ...PLAIN_OUTPUT_ENV,
      SPOTIPY_CLIENT_ID: "id",
    });
  });

  it("cancel SIGTERMs the child", async () => {
    const capture: { killed?: string } = {};
    const run = runSpotdl(
      "https://open.spotify.com/album/x",
      stageFor("cancel"),
      { binaryPath: "spotdl" },
      { spawn: fakeSpawn({ hang: true }, capture) },
    );
    await new Promise((r) => setTimeout(r, 2));
    expect(run.cancel()).toBe(true);
    const result = await run.done;
    expect(capture.killed).toBe("SIGTERM");
    expect(result.exitCode).toBeNull();
  });
});
