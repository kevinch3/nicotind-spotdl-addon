import { describe, it, expect } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { JobStore } from './job-store.js';
import { createServer } from './server.js';

const TOKEN = 'test-token';

function fakeSpawn(stage: string) {
  return ((_bin: string, args: string[]) => {
    const em = new EventEmitter();
    // spotdl --output <staging>/{artist}/{album}/{title}.{ext}; the staging base
    // is the first path segment of the --output template.
    const outIdx = args.indexOf('--output');
    const template = args[outIdx + 1]!;
    const base = template.split('{artist}')[0]!;
    queueMicrotask(() => {
      mkdirSync(join(base, 'A', 'B'), { recursive: true });
      writeFileSync(join(base, 'A', 'B', 'Song.mp3'), 'audio');
      em.emit('close', 0);
    });
    return em;
  }) as unknown as typeof import('node:child_process').spawn;
}

function makeApp() {
  const stage = join(tmpdir(), `sps-${process.pid}-${Date.now()}`);
  const jobs = new JobStore(stage, () => ({ binaryPath: 'spotdl' }), { spawn: fakeSpawn(stage) });
  return createServer({ token: TOKEN, jobs });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('spotdl addon server', () => {
  it('serves the manifest unauthenticated with the spotify.com pattern at default priority', async () => {
    const res = await makeApp().request('/addon/v1/manifest');
    expect(res.status).toBe(200);
    const m = (await res.json()) as { id: string; priority?: number; urlPatterns: string[] };
    expect(m.id).toBe('spotdl-addon');
    // No explicit priority → default 0, which beats yt-dlp's -10 catch-all.
    expect(m.priority).toBeUndefined();
    expect(m.urlPatterns).toContain('spotify\\.com');
  });

  it('401s a jobs call without the bearer token', async () => {
    const res = await makeApp().request('/addon/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ intent: 'url', url: 'https://open.spotify.com/album/x' }),
    });
    expect(res.status).toBe(401);
  });

  it('resolves a url job → fileReady item → serves the bytes', async () => {
    const app = makeApp();
    const created = await app.request('/addon/v1/jobs', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'url', url: 'https://open.spotify.com/album/x' }),
    });
    expect(created.status).toBe(201);
    const { job } = (await created.json()) as { job: { id: string } };

    // Poll until the background resolve completes.
    let done: { id: string; state: string; items: Array<{ itemId: string; fileReady: boolean }> } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await app.request(`/addon/v1/jobs/${job.id}`, { headers: auth });
      const body = (await res.json()) as { job: typeof done };
      if (body.job && body.job.state !== 'active') {
        done = body.job;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(done?.state).toBe('done');
    expect(done?.items[0]?.fileReady).toBe(true);

    const file = await app.request(
      `/addon/v1/jobs/${job.id}/files/${encodeURIComponent(done!.items[0]!.itemId)}`,
      { headers: auth },
    );
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('audio');
  });
});
