import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AddonJob, AddonJobItem } from '@nicotind/addon-sdk';
import { resolveSpotdl, type SpotdlConfig, type ResolveDeps } from './resolve.js';

interface JobEntry {
  job: AddonJob;
  paths: Map<string, string>;
}

/**
 * In-memory job store. `create` returns an active job immediately and resolves
 * the URL in the background (spotDL runs for seconds/minutes), so core's poll
 * sees an in-flight job flip to `done` with `fileReady` items — the exact loop
 * the archive/slskd/yt-dlp addons use. Files stage under `<stagingBase>/<jobId>/`.
 */
export class JobStore {
  private jobs = new Map<string, JobEntry>();

  constructor(
    private readonly stagingBase: string,
    private readonly config: () => SpotdlConfig,
    private readonly deps: ResolveDeps = {},
  ) {}

  create(url: string): AddonJob {
    const id = randomUUID();
    const job: AddonJob = {
      id,
      // The published @nicotind/addon-sdk@0.1.0 predates the 'url' intent (shipped
      // in core, unpublished). Core's manifest/job schema accepts it; drop this
      // cast once addon-sdk ^0.1.1 (with 'url') is published + this dep bumps.
      intent: 'url' as unknown as AddonJob['intent'],
      artist: null,
      album: null,
      state: 'active',
      error: null,
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const entry: JobEntry = { job, paths: new Map() };
    this.jobs.set(id, entry);
    void this.run(id, url, entry);
    return job;
  }

  private async run(id: string, url: string, entry: JobEntry): Promise<void> {
    try {
      const files = await resolveSpotdl(url, join(this.stagingBase, id), this.config(), this.deps);
      if (files.length === 0) throw new Error('spotDL produced no audio files');
      entry.job.items = files.map((f, i): AddonJobItem => {
        const itemId = `${id}:${i}`;
        entry.paths.set(itemId, f.path);
        return {
          itemId,
          title: null,
          username: 'spotdl-addon',
          filename: f.filename,
          size: f.size,
          state: 'completed',
          fileReady: true,
          updatedAt: Date.now(),
        };
      });
      entry.job.state = 'done';
      entry.job.updatedAt = Date.now();
    } catch (err) {
      entry.job.state = 'failed';
      entry.job.error = err instanceof Error ? err.message : String(err);
      entry.job.updatedAt = Date.now();
    }
  }

  get(id: string): AddonJob | undefined {
    return this.jobs.get(id)?.job;
  }

  list(sinceMs = 0): AddonJob[] {
    return [...this.jobs.values()].map((e) => e.job).filter((j) => j.updatedAt > sinceMs);
  }

  remove(id: string): void {
    this.jobs.delete(id);
  }

  filePath(id: string, itemId: string): string | undefined {
    return this.jobs.get(id)?.paths.get(itemId);
  }
}
