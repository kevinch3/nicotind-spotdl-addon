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
  runSpotdlWithRetry,
  isPreflightThrottleCrash,
  PLAIN_OUTPUT_ENV,
  type RunResult,
} from "./resolve.js";

type SpawnFn = typeof import("node:child_process").spawn;

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

  it("accepts several queries at once — the bounded per-track retry pass (issue #651 item C)", () => {
    const args = buildArgs(
      ["https://open.spotify.com/track/a", "https://open.spotify.com/track/b"],
      "/stage",
      { binaryPath: "spotdl" },
    );
    expect(args[0]).toBe("download");
    expect(args[1]).toBe("https://open.spotify.com/track/a");
    expect(args[2]).toBe("https://open.spotify.com/track/b");
    expect(args[3]).toBe("--output");
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

/** A trimmed but faithful capture of the real crash (NicotinD #601 symptom 1,
 *  reconfirmed on prod 2026-08-23 — issue #651 item A): spotDL's preflight
 *  `check_ytmusic_connection()` dies on a throttled, non-JSON YouTube Music
 *  response before a single track is attempted. */
const PREFLIGHT_CRASH_TAIL = [
  "╭──────────── Traceback (most recent call last) ────────────╮",
  "│ .../spotdl/console/entry_point.py:100 in entry_point       │",
  "│ ❱ 100 │   │   if not check_ytmusic_connection():            │",
  "│ .../spotdl/utils/downloader.py:21 in check_ytmusic_connection │",
  "│ .../json/decoder.py:363 in raw_decode                      │",
  "╰──────────────────────────────────────────────────────────╯",
  "JSONDecodeError: Expecting value: line 1 column 1 (char 0)",
].join("\n");

function fakeResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    files: [],
    exitCode: 1,
    errorLines: [],
    outputTail: "",
    ...overrides,
  };
}

describe("isPreflightThrottleCrash", () => {
  it("is true for spotDL's preflight JSONDecodeError with no files landed", () => {
    expect(
      isPreflightThrottleCrash(
        fakeResult({ outputTail: PREFLIGHT_CRASH_TAIL }),
      ),
    ).toBe(true);
  });

  it("is false when a file landed, even alongside the same tail", () => {
    expect(
      isPreflightThrottleCrash(
        fakeResult({
          outputTail: PREFLIGHT_CRASH_TAIL,
          files: [{ path: "/x/Song.mp3", filename: "Song.mp3", size: 1 }],
        }),
      ),
    ).toBe(false);
  });

  it("is false for a zero-file run that isn't this specific crash", () => {
    expect(
      isPreflightThrottleCrash(
        fakeResult({ outputTail: "usage: spotdl [-h] ...\nerror: invalid URL" }),
      ),
    ).toBe(false);
  });
});

describe("runSpotdlWithRetry", () => {
  const stageFor = (tag: string): string =>
    join(tmpdir(), `sp-retry-${process.pid}-${Date.now()}-${tag}`);

  /** Every real-timer wait replaced with an immediately-resolving stub that
   *  records what it was asked to sleep for. */
  function fakeWaits(): {
    wait: (ms: number) => Promise<void>;
    delays: number[];
  } {
    const delays: number[] = [];
    return {
      delays,
      wait: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    };
  }

  it("returns the first result untouched when spotDL succeeds outright", async () => {
    let spawns = 0;
    const spawn = fakeSpawn({
      lines: ['Downloaded "Artist - Song": https://youtu.be/1'],
      writeTo: () => {
        mkdirSync(stageFor("ok"), { recursive: true });
      },
      code: 0,
    });
    const { wait, delays } = fakeWaits();
    const run = runSpotdlWithRetry(
      "https://open.spotify.com/album/x",
      stageFor("ok"),
      { binaryPath: "spotdl" },
      {
        spawn: ((...a: Parameters<typeof spawn>) => {
          spawns++;
          return spawn(...a);
        }) as typeof spawn,
      },
      {},
      { wait },
    );
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    expect(spawns).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries the whole process on a preflight throttle crash, then succeeds", async () => {
    let spawns = 0;
    const spawn = ((...a: Parameters<SpawnFn>) => {
      spawns++;
      const attempt = spawns;
      return fakeSpawn({
        lines: attempt === 1 ? [PREFLIGHT_CRASH_TAIL] : ["Found 1 songs in X (Playlist)"],
        writeTo: attempt === 1 ? undefined : () => {},
        code: attempt === 1 ? 1 : 0,
      })(...a);
    }) as SpawnFn;
    const { wait, delays } = fakeWaits();
    const onOutput: string[] = [];
    const run = runSpotdlWithRetry(
      "https://open.spotify.com/album/x",
      stageFor("retry-ok"),
      { binaryPath: "spotdl" },
      { spawn },
      { onOutput: (l) => onOutput.push(l) },
      { wait, maxAttempts: 3, baseDelayMs: 1000, random: () => 0 },
    );
    const result = await run.done;
    expect(spawns).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(delays).toEqual([500]); // baseDelayMs * 2^0 * (0.5 + 0)
    expect(onOutput.some((l) => /rate-limit/i.test(l))).toBe(true);
  });

  it("gives up after maxAttempts, surfacing the last crash rather than looping forever", async () => {
    let spawns = 0;
    const spawn = ((...a: Parameters<SpawnFn>) => {
      spawns++;
      return fakeSpawn({ lines: [PREFLIGHT_CRASH_TAIL], code: 1 })(...a);
    }) as SpawnFn;
    const { wait } = fakeWaits();
    const run = runSpotdlWithRetry(
      "https://open.spotify.com/album/x",
      stageFor("retry-fail"),
      { binaryPath: "spotdl" },
      { spawn },
      {},
      { wait, maxAttempts: 3, random: () => 0 },
    );
    const result = await run.done;
    expect(spawns).toBe(3);
    expect(isPreflightThrottleCrash(result)).toBe(true);
  });

  it("does not retry a zero-file failure that isn't the preflight signature", async () => {
    let spawns = 0;
    const spawn = ((...a: Parameters<SpawnFn>) => {
      spawns++;
      return fakeSpawn({ lines: ["error: invalid URL"], code: 2 })(...a);
    }) as SpawnFn;
    const { wait } = fakeWaits();
    const run = runSpotdlWithRetry(
      "https://open.spotify.com/album/x",
      stageFor("no-retry"),
      { binaryPath: "spotdl" },
      { spawn },
      {},
      { wait, maxAttempts: 3, random: () => 0 },
    );
    await run.done;
    expect(spawns).toBe(1);
  });

  it("cancel() during the backoff wait stops it from spawning again", async () => {
    let spawns = 0;
    const spawn = ((...a: Parameters<SpawnFn>) => {
      spawns++;
      return fakeSpawn({ lines: [PREFLIGHT_CRASH_TAIL], code: 1 })(...a);
    }) as SpawnFn;
    let resolveWait: () => void = () => {};
    const wait = () => new Promise<void>((r) => (resolveWait = r));
    const run = runSpotdlWithRetry(
      "https://open.spotify.com/album/x",
      stageFor("cancel-mid-retry"),
      { binaryPath: "spotdl" },
      { spawn },
      {},
      { wait, maxAttempts: 3, random: () => 0 },
    );
    // Let the first attempt crash and the retry wait begin.
    await new Promise((r) => setTimeout(r, 5));
    expect(run.cancel()).toBe(true);
    resolveWait();
    const result = await run.done;
    expect(spawns).toBe(1);
    expect(isPreflightThrottleCrash(result)).toBe(true);
  });
});
