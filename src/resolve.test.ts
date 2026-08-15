import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { buildArgs, spotifyEnv, resolveSpotdl } from './resolve.js';

// A fake spotdl: runs `writeTo` (dropping files into staging), then closes.
// Captures the spawn options so tests can assert the env layer.
function fakeSpawn(writeTo: () => void, capture?: { opts?: unknown }) {
  return ((_bin: string, _args: string[], opts?: unknown) => {
    if (capture) capture.opts = opts;
    const em = new EventEmitter();
    queueMicrotask(() => {
      writeTo();
      em.emit('close', 0);
    });
    return em;
  }) as unknown as typeof import('node:child_process').spawn;
}

describe('buildArgs', () => {
  it('downloads with skip-overwrite and bitrate-disable (no lossy re-encode)', () => {
    const args = buildArgs('https://open.spotify.com/album/x', '/stage', { binaryPath: 'spotdl' });
    expect(args[0]).toBe('download');
    expect(args).toContain('--overwrite');
    expect(args).toContain('skip');
    expect(args.join(' ')).toContain('--bitrate disable');
  });
});

describe('spotifyEnv', () => {
  it('is null when creds are absent, and forwards SPOTIPY vars when both set', () => {
    expect(spotifyEnv({ binaryPath: 'spotdl' })).toBeNull();
    expect(spotifyEnv({ binaryPath: 'spotdl', clientId: 'a', clientSecret: '' })).toBeNull();
    const env = spotifyEnv({ binaryPath: 'spotdl', clientId: 'a', clientSecret: 'b' });
    expect(env).toEqual({ SPOTIPY_CLIENT_ID: 'a', SPOTIPY_CLIENT_SECRET: 'b' });
  });
});

describe('resolveSpotdl', () => {
  it('returns the audio files that landed in staging', async () => {
    const stage = join(tmpdir(), `sp-${process.pid}-${Date.now()}`);
    const write = (): void => {
      mkdirSync(join(stage, 'Artist', 'Album'), { recursive: true });
      writeFileSync(join(stage, 'Artist', 'Album', 'Song.mp3'), 'audio-bytes');
    };
    const files = await resolveSpotdl(
      'https://open.spotify.com/album/x',
      stage,
      { binaryPath: 'spotdl' },
      { spawn: fakeSpawn(write) },
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toBe('Song.mp3');
    expect(files[0]!.size).toBeGreaterThan(0);
  });

  it('forwards the Spotify creds env to the spawned process when configured', async () => {
    const stage = join(tmpdir(), `sp-${process.pid}-${Date.now()}-env`);
    const cap: { opts?: unknown } = {};
    await resolveSpotdl(
      'https://open.spotify.com/track/x',
      stage,
      { binaryPath: 'spotdl', clientId: 'cid', clientSecret: 'sec' },
      { spawn: fakeSpawn(() => {}, cap) },
    );
    const env = (cap.opts as { env?: Record<string, string> }).env!;
    expect(env.SPOTIPY_CLIENT_ID).toBe('cid');
    expect(env.SPOTIPY_CLIENT_SECRET).toBe('sec');
  });
});
