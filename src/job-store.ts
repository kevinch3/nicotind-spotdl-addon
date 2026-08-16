import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { AddonJob, AddonJobItem } from '@nicotind/addon-sdk';
import { resolveSpotdl, type SpotdlConfig, type ResolveDeps } from './resolve.js';

interface JobEntry {
  job: AddonJob;
  paths: Map<string, string>;
}

interface JobRow {
  id: string;
  job_json: string;
  files_json: string;
}

/**
 * SQLite-backed job store (issue #515). `create` returns an active job
 * immediately and resolves the URL in the background (spotDL runs for
 * seconds/minutes), so core's poll sees an in-flight job flip to `done` with
 * `fileReady` items — the exact loop the archive/slskd/yt-dlp addons use. Files
 * stage under `<stagingBase>/<jobId>/`.
 *
 * **Why persist** (the ghost-card fix): jobs used to live only in memory, so a
 * restart mid-download dropped them and core's cursor poll never revisited them
 * — they sat "downloading" until core's 24h valve (#515/#516). Now every
 * mutation writes through to `<dataDir>/jobs.db`, and on boot any job still
 * `active` is marked **failed** (the process that was downloading it is gone),
 * so core surfaces an honest failure instead of a ghost. The in-memory Map is
 * kept as a write-through cache so the frequently-polled `list`/`get` stay hot.
 */
export class JobStore {
  private jobs = new Map<string, JobEntry>();
  private db: Database;

  constructor(
    private readonly stagingBase: string,
    private readonly config: () => SpotdlConfig,
    private readonly deps: ResolveDeps = {},
    dbPath = ':memory:',
  ) {
    this.db = new Database(dbPath);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id         TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        job_json   TEXT NOT NULL,
        files_json TEXT NOT NULL
      )
    `);
    this.hydrate();
  }

  /**
   * Rebuild the in-memory cache from disk on boot. A job still `active` means
   * the addon died while downloading it — mark it failed (with a fresh
   * `updatedAt` so core's cursor poll picks up the transition) rather than let
   * it ghost forever.
   */
  private hydrate(): void {
    const rows = this.db.query<JobRow, []>(`SELECT id, job_json, files_json FROM jobs`).all();
    for (const row of rows) {
      let entry: JobEntry;
      try {
        const job = JSON.parse(row.job_json) as AddonJob;
        const paths = new Map(
          Object.entries(JSON.parse(row.files_json) as Record<string, string>),
        );
        entry = { job, paths };
      } catch {
        // A corrupt row must never take the boot path down — drop it.
        this.db.run(`DELETE FROM jobs WHERE id = ?`, [row.id]);
        continue;
      }
      if (entry.job.state === 'active') {
        entry.job.state = 'failed';
        entry.job.error = 'The addon restarted while this download was in progress.';
        entry.job.updatedAt = Date.now();
        this.persist(entry);
      }
      this.jobs.set(entry.job.id, entry);
    }
  }

  private persist(entry: JobEntry): void {
    const files: Record<string, string> = {};
    for (const [k, v] of entry.paths) files[k] = v;
    this.db.run(
      `INSERT INTO jobs (id, state, updated_at, job_json, files_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state, updated_at = excluded.updated_at,
         job_json = excluded.job_json, files_json = excluded.files_json`,
      [
        entry.job.id,
        entry.job.state,
        entry.job.updatedAt,
        JSON.stringify(entry.job),
        JSON.stringify(files),
      ],
    );
  }

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
    this.persist(entry); // durable as `active` before the background run starts
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
    } finally {
      this.persist(entry);
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
    this.db.run(`DELETE FROM jobs WHERE id = ?`, [id]);
  }

  filePath(id: string, itemId: string): string | undefined {
    return this.jobs.get(id)?.paths.get(itemId);
  }
}
