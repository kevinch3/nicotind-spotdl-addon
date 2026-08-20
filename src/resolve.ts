import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { createInterface } from "node:readline";
import {
  parseSpotdlPlaylistTitle,
  parseSpotdlProgress,
  parseSpotdlTrackEvent,
  type DownloaderTrackEvent,
} from "@nicotind/addon-sdk";

const AUDIO_EXT = new Set([
  ".mp3",
  ".m4a",
  ".opus",
  ".flac",
  ".ogg",
  ".wav",
  ".aac",
]);

export interface SpotdlConfig {
  binaryPath: string;
  cookiesFile?: string;
  /** Spotify API credentials (optional) — raise spotDL's rate limits over its
   *  built-in shared client. Forwarded as SPOTIPY_CLIENT_ID/SECRET on spawn. */
  clientId?: string;
  clientSecret?: string;
  /** spotDL's own download thread pool. See DEFAULT_THREADS. */
  threads?: number;
}

export interface ResolveDeps {
  /** Injectable spawner (tests pass a fake). */
  spawn?: typeof nodeSpawn;
}

export interface ResolvedFile {
  path: string;
  filename: string;
  size: number;
}

/**
 * What the run reports while it is going. Every hook is optional and fires
 * line-at-a-time as spotDL writes; nothing is buffered to the end.
 */
export interface RunHooks {
  /** The list's name — `Found 16 songs in <name> (Playlist)` — at most once. */
  onTitle?: (title: string) => void;
  /** The announced song count, at most once. */
  onTotal?: (total: number) => void;
  /** One per `Downloaded` / `Skipping` / `--print-errors` line, in output order. */
  onTrack?: (event: DownloaderTrackEvent) => void;
  /** Every output line, for the addon's own log. */
  onOutput?: (line: string) => void;
}

export interface RunResult {
  files: ResolvedFile[];
  exitCode: number | null;
  /** `ERROR`-level lines spotDL wrote, oldest first — the real reasons. */
  errorLines: string[];
  /** The last ~2 KB of combined output, for a run that said nothing useful. */
  outputTail: string;
}

export interface RunningResolve {
  done: Promise<RunResult>;
  /** SIGTERM spotDL. Returns whether a process was signalled. */
  cancel: () => boolean;
}

/**
 * spotDL argument vector. Mirrors the retired in-process plugin: download into an
 * {artist}/{album}/{title} tree, `--overwrite skip` so a resumed job doesn't
 * re-fetch, and `--bitrate disable` so the source YouTube stream is copied
 * through untouched (no lossy→lossy re-encode; core's own lossless→Opus pass
 * standardizes later at a controlled bitrate).
 *
 * The three output flags are what make the stream parseable: `--simple-tui`
 * drops the live progress table, `--log-level INFO` keeps the `Found`/
 * `Downloaded`/`Skipping` lines, and `--print-errors` makes spotDL end the run
 * with one `<url> - <Exception>: <reason>` line per song it could not get —
 * off by default, and without it a failed track leaves no trace at all.
 */
/**
 * spotDL's default thread pool is 4, and the addon used to run every job the
 * moment it arrived — so two playlists meant ~8 concurrent YouTube fetches from
 * one IP. YouTube rate-limited the deployment down to ~9 % success (issue #601:
 * 134 downloads against 793 search misses + 485 yt-dlp errors over 12 h), which
 * looks exactly like "the song isn't on YouTube" and isn't. Jobs are serialized
 * in `JobStore` and each one's fan-out is capped here; the two together are the
 * fix, since serializing alone still leaves 4 in flight.
 */
export const DEFAULT_THREADS = 2;
/** Above this, a value is a typo rather than an intent — clamp, don't obey. */
export const MAX_THREADS = 8;

/** Clamp to a sane pool size; a missing/garbage value falls back to the default. */
export function resolveThreads(threads: number | undefined): number {
  if (threads === undefined || !Number.isFinite(threads)) return DEFAULT_THREADS;
  return Math.min(MAX_THREADS, Math.max(1, Math.trunc(threads)));
}

export function buildArgs(
  url: string,
  stagingDir: string,
  cfg: SpotdlConfig,
): string[] {
  const args = [
    "download",
    url,
    "--output",
    join(stagingDir, "{artist}", "{album}", "{title}.{output-ext}"),
    "--overwrite",
    "skip",
    "--bitrate",
    "disable",
    "--simple-tui",
    "--log-level",
    "INFO",
    "--print-errors",
    "--threads",
    String(resolveThreads(cfg.threads)),
  ];
  if (cfg.cookiesFile && existsSync(cfg.cookiesFile))
    args.push("--cookie-file", cfg.cookiesFile);
  return args;
}

/**
 * The env layer forwarding Spotify credentials to spotDL (spotipy reads these).
 * Returns `null` when neither is set, so callers omit the layer and spotDL falls
 * back to its shared client.
 */
export function spotifyEnv(cfg: SpotdlConfig): NodeJS.ProcessEnv | null {
  const id = cfg.clientId?.trim();
  const secret = cfg.clientSecret?.trim();
  if (!id || !secret) return null;
  return { SPOTIPY_CLIENT_ID: id, SPOTIPY_CLIENT_SECRET: secret };
}

/**
 * spotDL logs through `rich`, which — even with no TTY — colours its output and
 * soft-wraps at a guessed 80 columns, splitting a long `Downloaded "…": url`
 * line across two reads. `rich` honours these three variables, so the stream
 * arrives plain and one-line-per-event.
 */
export const PLAIN_OUTPUT_ENV: NodeJS.ProcessEnv = {
  NO_COLOR: "1",
  TERM: "dumb",
  COLUMNS: "4000",
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function globAudioFiles(dir: string): ResolvedFile[] {
  const out: ResolvedFile[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (AUDIO_EXT.has(extname(entry.name).toLowerCase())) {
        out.push({ path: p, filename: basename(p), size: statSync(p).size });
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Spawn spotDL for `url`, downloading audio into `stagingDir`, streaming its
 * output through `hooks`, and settle with the files that landed plus what the
 * run said about itself. Success is the caller's call: spotDL exits non-zero on
 * a partial playlist, so the exit code alone decides nothing — the files and the
 * per-track events do. YouTube PO tokens come from the baked bgutil plugin
 * reaching the pot-provider sidecar at its default 127.0.0.1:4416 (shared
 * netns) — spotDL can't thread extractor-args, so this stays a compose-topology
 * contract.
 */
export function runSpotdl(
  url: string,
  stagingDir: string,
  cfg: SpotdlConfig,
  deps: ResolveDeps = {},
  hooks: RunHooks = {},
): RunningResolve {
  const spawn = deps.spawn ?? nodeSpawn;
  const args = buildArgs(url, stagingDir, cfg);
  const creds = spotifyEnv(cfg);
  const child: ChildProcess = spawn(cfg.binaryPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...PLAIN_OUTPUT_ENV, ...(creds ?? {}) },
  });

  let titleSeen = false;
  let totalSeen = false;
  let progress = { done: 0, total: 0 };
  const errorLines: string[] = [];
  let tail = "";
  const onLine = (raw: string): void => {
    const line = raw.replace(ANSI, "").trimEnd();
    if (!line) return;
    hooks.onOutput?.(line);
    tail = (tail + line + "\n").slice(-2048);
    if (/\bERROR\b/.test(line) || /^https?:\/\/\S+ - \w+: /.test(line))
      errorLines.push(line);
    if (!titleSeen) {
      const title = parseSpotdlPlaylistTitle(line);
      if (title) {
        titleSeen = true;
        hooks.onTitle?.(title);
      }
    }
    if (!totalSeen) {
      const next = parseSpotdlProgress(line, progress);
      if (next.total > 0 && next.total !== progress.total) {
        totalSeen = true;
        hooks.onTotal?.(next.total);
      }
      progress = next;
    }
    const event = parseSpotdlTrackEvent(line);
    if (event) hooks.onTrack?.(event);
  };

  const readers: Promise<void>[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", onLine);
    readers.push(new Promise((resolve) => rl.once("close", () => resolve())));
  }

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      // Drain both line readers before reporting: `close` can beat the last
      // buffered line, and that line is usually the `--print-errors` summary.
      void Promise.all(readers).then(() =>
        resolve({
          files: globAudioFiles(stagingDir),
          exitCode: code,
          errorLines,
          outputTail: tail,
        }),
      );
    });
  });

  return {
    done,
    cancel: () => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      return child.kill("SIGTERM");
    },
  };
}
