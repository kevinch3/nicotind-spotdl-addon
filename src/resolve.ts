import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.opus', '.flac', '.ogg', '.wav', '.aac']);

export interface SpotdlConfig {
  binaryPath: string;
  cookiesFile?: string;
  /** Spotify API credentials (optional) — raise spotDL's rate limits over its
   *  built-in shared client. Forwarded as SPOTIPY_CLIENT_ID/SECRET on spawn. */
  clientId?: string;
  clientSecret?: string;
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
 * spotDL argument vector. Mirrors the retired in-process plugin: download into an
 * {artist}/{album}/{title} tree, `--overwrite skip` so a resumed job doesn't
 * re-fetch, and `--bitrate disable` so the source YouTube stream is copied
 * through untouched (no lossy→lossy re-encode; core's own lossless→Opus pass
 * standardizes later at a controlled bitrate).
 */
export function buildArgs(url: string, stagingDir: string, cfg: SpotdlConfig): string[] {
  const args = [
    'download',
    url,
    '--output',
    join(stagingDir, '{artist}', '{album}', '{title}.{output-ext}'),
    '--overwrite',
    'skip',
    '--bitrate',
    'disable',
  ];
  if (cfg.cookiesFile && existsSync(cfg.cookiesFile)) args.push('--cookie-file', cfg.cookiesFile);
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
 * Spawn spotDL for `url`, downloading audio into `stagingDir`, and return the
 * files that landed. spotDL can exit non-zero on a partial playlist, so success
 * is decided by whether audio files landed — not the exit code (matches the
 * plugin). YouTube PO tokens come from the baked bgutil plugin reaching the
 * pot-provider sidecar at its default 127.0.0.1:4416 (shared netns) — spotDL
 * can't thread extractor-args, so this stays a compose-topology contract.
 */
export async function resolveSpotdl(
  url: string,
  stagingDir: string,
  cfg: SpotdlConfig,
  deps: ResolveDeps = {},
): Promise<ResolvedFile[]> {
  const spawn = deps.spawn ?? nodeSpawn;
  const args = buildArgs(url, stagingDir, cfg);
  const creds = spotifyEnv(cfg);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cfg.binaryPath, args, {
      stdio: 'ignore',
      env: creds ? { ...process.env, ...creds } : process.env,
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  return globAudioFiles(stagingDir);
}
