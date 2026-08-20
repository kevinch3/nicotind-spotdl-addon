import { randomUUID } from "node:crypto";
import { join, basename, extname, dirname } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AddonJob,
  AddonJobItem,
  DownloaderTrackEvent,
} from "@nicotind/addon-sdk";
import {
  runSpotdl,
  type SpotdlConfig,
  type ResolveDeps,
  type ResolvedFile,
  type RunningResolve,
} from "./resolve.js";

interface JobEntry {
  job: AddonJob;
  paths: Map<string, string>;
}

interface JobRow {
  id: string;
  job_json: string;
  files_json: string;
}

const USERNAME = "spotdl-addon";

/** Fold a song label / filename to a comparison key (see `matchFilesToItems`). */
export function trackKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Pair the files that landed with the tracks spotDL reported. spotDL names a
 * song `Artist - Title` in its log and files it as `<stage>/<artist>/<album>/
 * <title>.<ext>` — so `<artist dir> - <stem>` is the same label, modulo the
 * characters spotDL strips from filenames, which `trackKey` drops from both
 * sides. Returns the item index each file belongs to, or -1 for a file no
 * reported track claims (it still ships — it is real audio).
 */
export function matchFilesToItems(
  files: ResolvedFile[],
  titles: ReadonlyArray<string | null>,
): number[] {
  const byKey = new Map<string, number>();
  titles.forEach((t, i) => {
    if (t) byKey.set(trackKey(t), i);
  });
  const claimed = new Set<number>();
  return files.map((f) => {
    const stem = basename(f.path, extname(f.path));
    const artist = basename(dirname(dirname(f.path)));
    for (const key of [trackKey(`${artist} - ${stem}`), trackKey(stem)]) {
      const idx = byKey.get(key);
      if (idx !== undefined && !claimed.has(idx)) {
        claimed.add(idx);
        return idx;
      }
    }
    return -1;
  });
}

/**
 * SQLite-backed job store (issue #515). `create` returns an active job
 * immediately and resolves the URL in the background (spotDL runs for
 * seconds/minutes), so core's poll sees an in-flight job flip to `done` with
 * `fileReady` items — the exact loop the archive/slskd/yt-dlp addons use. Files
 * stage under `<stagingBase>/<jobId>/`.
 *
 * **What a job reports** (NicotinD issue #585): this store used to glob staging
 * after spotDL exited and call whatever it found a complete job — so a playlist
 * of 16 where one track came through read as a clean "Done 1 of 1" under the
 * source label, and the addon kept no record of why. Now spotDL's output is
 * read as it runs: the list's name becomes `AddonJob.title`, every
 * `Downloaded`/`Skipping`/failed line becomes an item **in that order**, and a
 * shortfall against the announced total is filled with `unavailable`
 * placeholders so the host's count is honest. The job closes `done` only when
 * every track landed, `partial` with spotDL's own error lines otherwise, and
 * `failed` when nothing did.
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
  private running = new Map<string, RunningResolve>();
  /** Pending runs, oldest first. Drained one at a time — see `enqueue`. */
  private queue: Array<() => Promise<void>> = [];
  private draining = false;
  private db: Database;

  constructor(
    private readonly stagingBase: string,
    private readonly config: () => SpotdlConfig,
    private readonly deps: ResolveDeps = {},
    dbPath = ":memory:",
    private readonly log: (line: string) => void = (line) => console.log(line),
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
    const rows = this.db
      .query<JobRow, []>(`SELECT id, job_json, files_json FROM jobs`)
      .all();
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
      if (entry.job.state === "active") {
        entry.job.state = "failed";
        entry.job.error =
          "The addon restarted while this download was in progress.";
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
      intent: "url",
      artist: null,
      album: null,
      title: null,
      state: "active",
      error: null,
      items: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const entry: JobEntry = { job, paths: new Map() };
    this.jobs.set(id, entry);
    this.persist(entry); // durable as `active` before the background run starts
    this.enqueue(() => this.run(id, url, entry));
    return job;
  }

  /**
   * Run one spotDL at a time (NicotinD #601). Every `create` used to spawn
   * immediately, so importing three playlists meant three concurrent spotDLs —
   * each with its own thread pool — hammering YouTube from one IP until it
   * rate-limited us to ~9 % success. A playlist import is not latency-sensitive,
   * and a queued job is still `active` and visible to core's poll from the
   * moment it is created, so the wait costs the user nothing but a later start.
   */
  private enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let next: (() => Promise<void>) | undefined;
      while ((next = this.queue.shift())) {
        // `run` handles its own failures; guard anyway so one thrown task can
        // never strand every job behind it.
        try {
          await next();
        } catch {
          /* already recorded on the job */
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(id: string, url: string, entry: JobEntry): Promise<void> {
    const { job } = entry;
    // Serializing made "cancelled before it ever started" reachable: `cancel`
    // has no process to signal while a job is still queued, so the queue itself
    // must drop it rather than spawn spotDL for a job the user already closed.
    // Narrow a copy, not `job.state` itself: `cancel()` mutates it during the
    // await below, and narrowing the field would make that check look dead.
    const startState: AddonJob["state"] = job.state;
    if (startState !== "active") return;
    let expected = 0;
    let seq = 0;
    const touch = (): void => {
      job.updatedAt = Date.now();
      this.persist(entry);
    };
    const item = (
      title: string | null,
      state: AddonJobItem["state"],
    ): AddonJobItem => ({
      itemId: `${id}:${seq++}`,
      title,
      username: USERNAME,
      filename: "",
      size: 0,
      state,
      fileReady: false,
      updatedAt: Date.now(),
    });
    const onTrack = (ev: DownloaderTrackEvent): void => {
      // spotDL reports each song once, when it is finished with it; a second
      // line for the same title (a retry) updates rather than duplicates.
      const state: AddonJobItem["state"] =
        ev.status === "failed" ? "unavailable" : "completed";
      const existing = job.items.find((i) => i.title === ev.title);
      if (existing) {
        existing.state = state;
        existing.updatedAt = Date.now();
        touch();
        return;
      }
      // Claim a placeholder rather than appending past the announced total.
      const slot = job.items.find((i) => i.state === "queued");
      if (slot) {
        slot.title = ev.title;
        slot.state = state;
        slot.updatedAt = Date.now();
      } else {
        job.items.push(item(ev.title, state));
      }
      touch();
    };

    try {
      const running = runSpotdl(
        url,
        join(this.stagingBase, id),
        this.config(),
        this.deps,
        {
          onTitle: (title) => {
            job.title = title;
            touch();
          },
          onTotal: (total) => {
            expected = total;
            // Announce the whole set at once (NicotinD #595). spotDL prints
            // "Found N songs" up front but reports tracks one at a time, so the
            // card used to walk 0-of-1 -> 2-of-14 -> 7-of-32 as the denominator
            // caught up. `queued` placeholders make the denominator honest from
            // the first poll; each is claimed as its track lands.
            for (let n = job.items.length; n < total; n++)
              job.items.push(item(null, "queued"));
            touch();
          },
          onTrack,
          onOutput: (line) => this.log(`[spotdl ${id.slice(0, 8)}] ${line}`),
        },
      );
      this.running.set(id, running);
      const result = await running.done;
      if (job.state === "cancelled") return; // `cancel()` already closed it

      // Attach the files that landed to the tracks that reported them.
      const owner = matchFilesToItems(
        result.files,
        job.items.map((i) => i.title),
      );
      result.files.forEach((f, fi) => {
        let target = owner[fi]! >= 0 ? job.items[owner[fi]!]! : undefined;
        if (!target) target = job.items.find((i) => i.state === "queued");
        if (!target) {
          target = item(basename(f.path, extname(f.path)), "completed");
          job.items.push(target);
        }
        if (!target.title) target.title = basename(f.path, extname(f.path));
        target.state = "completed";
        target.fileReady = true;
        target.filename = f.filename;
        target.size = f.size;
        target.updatedAt = Date.now();
        entry.paths.set(target.itemId, f.path);
      });
      // A track spotDL said it downloaded but whose file is not there is not
      // deliverable — say so rather than hand the host an item it can't fetch.
      for (const i of job.items) {
        if (i.state === "completed" && !i.fileReady) i.state = "unavailable";
        // A placeholder spotDL never reached is not deliverable either; the run
        // is over, so nothing stays `queued`.
        if (i.state === "queued") i.state = "unavailable";
      }
      // The announced total is the honest denominator: tracks spotDL never
      // mentioned (it died before reaching them) become unavailable placeholders.
      for (let n = job.items.length; n < expected; n++)
        job.items.push(item(null, "unavailable"));

      const landed = job.items.filter((i) => i.fileReady).length;
      const reasons = result.errorLines.slice(-5).join("\n");
      if (landed === 0) {
        job.state = "failed";
        job.error =
          reasons ||
          result.outputTail.trim() ||
          `spotDL exited with code ${result.exitCode}`;
      } else if (landed < job.items.length) {
        job.state = "partial";
        job.error = `Downloaded ${landed} of ${job.items.length} tracks — the rest failed or were skipped.${
          reasons ? `\n${reasons}` : ""
        }`;
      } else {
        job.state = "done";
        job.error = null;
      }
    } catch (err) {
      job.state = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.running.delete(id);
      touch();
    }
  }

  get(id: string): AddonJob | undefined {
    return this.jobs.get(id)?.job;
  }

  list(sinceMs = 0): AddonJob[] {
    return [...this.jobs.values()]
      .map((e) => e.job)
      .filter((j) => j.updatedAt > sinceMs);
  }

  /**
   * Stop an in-flight job: SIGTERM spotDL and close the job `cancelled` with
   * every undelivered item `unavailable`. The host called this route before
   * and got a 404 — the route did not exist, so "Cancel" on a running Spotify
   * download read as an addon error. A job already settled is left alone.
   */
  cancel(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry || entry.job.state !== "active") return false;
    this.running.get(id)?.cancel();
    for (const i of entry.job.items) {
      if (!i.fileReady) i.state = "unavailable";
    }
    entry.job.state = "cancelled";
    entry.job.error = "Cancelled.";
    entry.job.updatedAt = Date.now();
    this.persist(entry);
    return true;
  }

  remove(id: string): void {
    this.cancel(id);
    this.jobs.delete(id);
    this.db.run(`DELETE FROM jobs WHERE id = ?`, [id]);
  }

  filePath(id: string, itemId: string): string | undefined {
    return this.jobs.get(id)?.paths.get(itemId);
  }
}
