import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { JobStore, matchFilesToItems, trackKey } from "./job-store.js";
import { fakeSpawn } from "./resolve.test.js";

/** A spotDL that writes the given `<artist>/<album>/<title>.mp3` files into the job's staging dir. */
function spotdlThat(
  lines: string[],
  files: Array<[string, string, string]>,
  code = 0,
  gate?: Promise<unknown>,
) {
  return ((bin: string, args: string[], opts?: unknown) => {
    const outIdx = args.indexOf("--output");
    const base = args[outIdx + 1]!.split("{artist}")[0]!;
    return fakeSpawn({
      lines,
      code,
      gate,
      writeTo: () => {
        for (const [artist, album, title] of files) {
          mkdirSync(join(base, artist, album), { recursive: true });
          writeFileSync(join(base, artist, album, `${title}.mp3`), "audio");
        }
      },
    })(bin, args, opts as never);
  }) as unknown as typeof import("node:child_process").spawn;
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "sps-persist-"));
  return { stage: join(dir, "downloads"), db: join(dir, "jobs.db") };
}

async function waitDone(store: JobStore, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (store.get(id)?.state !== "active") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job never left active");
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition never held");
}

const cfg = () => ({ binaryPath: "spotdl" });
const quiet = () => {};

describe("file ↔ track matching", () => {
  it("folds case, accents and the characters spotDL strips from filenames", () => {
    expect(trackKey("Ídolo (Deluxe)")).toBe(trackKey("idolo deluxe"));
    expect(trackKey("AC/DC - T.N.T.")).toBe(trackKey("ACDC - TNT"));
  });

  it('pairs <artist dir> - <stem> with the reported "Artist - Title"', () => {
    const files = [
      {
        path: "/s/Kaleb Di Masi/Techengue/Techengue.mp3",
        filename: "Techengue.mp3",
        size: 1,
      },
      { path: "/s/Nobody/X/Stray.mp3", filename: "Stray.mp3", size: 1 },
    ];
    expect(
      matchFilesToItems(files, [
        "Other - Song",
        "Kaleb Di Masi - Techengue",
        null,
      ]),
    ).toEqual([1, -1]);
  });
});

describe("what a job reports (NicotinD #585)", () => {
  it("a fully downloaded playlist: title, one completed item per track in output order, done", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: spotdlThat(
          [
            "Found 2 songs in Summer Mix (Playlist)",
            'Downloaded "B Artist - Second": https://y/2',
            'Downloaded "A Artist - First": https://y/1',
          ],
          [
            ["A Artist", "Alb", "First"],
            ["B Artist", "Alb", "Second"],
          ],
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://open.spotify.com/playlist/x");
    await waitDone(store, job.id);
    const got = store.get(job.id)!;
    expect(got.state).toBe("done");
    expect(got.title).toBe("Summer Mix");
    expect(got.error).toBeNull();
    // Output order, not disk order (A sorts before B on disk).
    expect(
      got.items.map((i) => [i.title, i.state, i.fileReady, i.filename]),
    ).toEqual([
      ["B Artist - Second", "completed", true, "Second.mp3"],
      ["A Artist - First", "completed", true, "First.mp3"],
    ]);
    for (const i of got.items)
      expect(store.filePath(job.id, i.itemId)).toEndWith(`${i.filename}`);
  });

  it("1 of 16 reads as a partial with 16 items, the unreported ones unavailable, and the reasons", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: spotdlThat(
          [
            "Found 16 songs in Big Mix (Playlist)",
            'Downloaded "Kaleb Di Masi - Techengue": https://y/1',
            "https://open.spotify.com/track/2 - LookupError: No results found for song: X - Y",
            "https://open.spotify.com/track/3 - AudioProviderError: YT-DLP download error",
          ],
          [["Kaleb Di Masi", "Techengue", "Techengue"]],
          1,
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://open.spotify.com/playlist/x");
    await waitDone(store, job.id);
    const got = store.get(job.id)!;
    expect(got.state).toBe("partial");
    expect(got.title).toBe("Big Mix");
    expect(got.items).toHaveLength(16);
    expect(got.items.filter((i) => i.fileReady)).toHaveLength(1);
    expect(got.items[0]!.title).toBe("Kaleb Di Masi - Techengue");
    expect(got.items[1]).toMatchObject({
      title: "X - Y",
      state: "unavailable",
    });
    expect(
      got.items
        .slice(3)
        .every((i) => i.state === "unavailable" && i.title === null),
    ).toBe(true);
    expect(got.error).toContain("Downloaded 1 of 16 tracks");
    expect(got.error).toContain(
      "LookupError: No results found for song: X - Y",
    );
  });

  it("a track spotDL claimed but never wrote is unavailable, a file it never mentioned still ships", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: spotdlThat(
          [
            "Found 1 songs in Lonely (Saved)",
            'Downloaded "A - Ghost": https://y/1',
          ],
          [["A", "Alb", "Surprise"]],
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://open.spotify.com/track/x");
    await waitDone(store, job.id);
    const got = store.get(job.id)!;
    expect(got.items.map((i) => [i.title, i.state, i.fileReady])).toEqual([
      ["A - Ghost", "unavailable", false],
      ["Surprise", "completed", true],
    ]);
    expect(got.state).toBe("partial");
  });

  it("nothing landed → failed, with spotDL's own lines as the reason", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: spotdlThat(
          [
            "Found 1 songs in Lonely (Saved)",
            "https://t/1 - LookupError: No results found for song: A - B",
          ],
          [],
          1,
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://open.spotify.com/track/x");
    await waitDone(store, job.id);
    expect(store.get(job.id)).toMatchObject({
      state: "failed",
      error: "https://t/1 - LookupError: No results found for song: A - B",
    });
  });

  it("the title and each track are visible to a poll while spotDL is still running", async () => {
    const { stage } = tmp();
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: ((bin: string, args: string[], o?: unknown) =>
          fakeSpawn({
            lines: [
              "Found 2 songs in Live Mix (Playlist)",
              'Downloaded "A - One": https://y/1',
            ],
            hang: true,
          })(
            bin,
            args,
            o as never,
          )) as unknown as typeof import("node:child_process").spawn,
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://open.spotify.com/playlist/x");
    await new Promise((r) => setTimeout(r, 20));
    const mid = store.get(job.id)!;
    expect(mid.state).toBe("active");
    expect(mid.title).toBe("Live Mix");
    // "Found 2 songs" is announced up front, so the poll sees both seats: the
    // one that landed, plus a `queued` placeholder for the one still to come
    // (NicotinD #595 — the denominator must not grow under the user).
    expect(mid.items.map((i) => i.title)).toEqual(["A - One", null]);
    expect(mid.items.map((i) => i.state)).toEqual(["completed", "queued"]);
    expect(mid.updatedAt).toBeGreaterThan(job.createdAt - 1);
    // …and cancel closes it with the undelivered track unavailable.
    expect(store.cancel(job.id)).toBe(true);
    expect(store.get(job.id)).toMatchObject({ state: "cancelled" });
    expect(store.get(job.id)!.items[0]!.state).toBe("unavailable");
    expect(store.cancel(job.id)).toBe(false); // already settled
  });

  it("writes every spotDL line to the addon log, tagged with the job", async () => {
    const { stage } = tmp();
    const logged: string[] = [];
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: spotdlThat(
          ["Found 1 songs in L (Saved)", 'Downloaded "A - B": u'],
          [["A", "X", "B"]],
        ),
      },
      ":memory:",
      (l) => logged.push(l),
    );
    const job = store.create("https://open.spotify.com/track/x");
    await waitDone(store, job.id);
    expect(logged).toEqual([
      `[spotdl ${job.id.slice(0, 8)}] Found 1 songs in L (Saved)`,
      `[spotdl ${job.id.slice(0, 8)}] Downloaded "A - B": u`,
    ]);
  });
});

describe("JobStore persistence (issue #515)", () => {
  it("a completed job + its file path survive a restart", async () => {
    const { stage, db } = tmp();
    const s1 = new JobStore(
      stage,
      cfg,
      { spawn: spotdlThat(['Downloaded "A - Song": u'], [["A", "B", "Song"]]) },
      db,
      quiet,
    );
    const job = s1.create("https://open.spotify.com/track/x");
    await waitDone(s1, job.id);
    expect(s1.get(job.id)!.state).toBe("done");
    const itemId = s1.get(job.id)!.items[0]!.itemId;

    const s2 = new JobStore(stage, cfg, {}, db, quiet);
    expect(s2.get(job.id)!.state).toBe("done");
    expect(s2.filePath(job.id, itemId)).toBe(
      join(stage, job.id, "A", "B", "Song.mp3"),
    );
  });

  it("an in-flight (active) job is marked failed on restart, not forgotten", () => {
    const { stage, db } = tmp();
    const raw = new Database(db);
    raw.run(
      `CREATE TABLE jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, job_json TEXT NOT NULL, files_json TEXT NOT NULL)`,
    );
    const job = {
      id: "j1",
      intent: "url",
      artist: null,
      album: null,
      state: "active",
      error: null,
      items: [],
      createdAt: 1,
      updatedAt: 1,
    };
    raw.run(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?)`, [
      "j1",
      "active",
      1,
      JSON.stringify(job),
      "{}",
    ]);
    raw.close();

    const store = new JobStore(stage, cfg, {}, db, quiet);
    const got = store.get("j1")!;
    expect(got.state).toBe("failed");
    expect(got.error).toContain("restarted");
    expect(got.updatedAt).toBeGreaterThan(1);
    expect(store.list(1)).toHaveLength(1);
  });

  it("remove deletes the row so it does not resurrect on restart", () => {
    const { stage, db } = tmp();
    const s1 = new JobStore(stage, cfg, {}, db, quiet);
    s1.remove("nope"); // no-op on unknown
    const raw = new Database(db);
    raw.run(`INSERT INTO jobs VALUES (?, ?, ?, ?, ?)`, [
      "j2",
      "done",
      5,
      JSON.stringify({
        id: "j2",
        intent: "url",
        artist: null,
        album: null,
        state: "done",
        error: null,
        items: [],
        createdAt: 1,
        updatedAt: 5,
      }),
      "{}",
    ]);
    raw.close();
    const s2 = new JobStore(stage, cfg, {}, db, quiet);
    expect(s2.get("j2")).toBeDefined();
    s2.remove("j2");
    const s3 = new JobStore(stage, cfg, {}, db, quiet);
    expect(s3.get("j2")).toBeUndefined();
  });
});

describe("the announced total is honest from the first poll (NicotinD #595)", () => {
  it("shows N queued placeholders as soon as spotDL announces the count", async () => {
    const { stage } = tmp();
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const store = new JobStore(
      stage,
      cfg,
      {
        spawn: spotdlThat(
          [
            "Found 14 songs in Opera Bangers (Playlist)",
            'Downloaded "A - One": https://y/1',
          ],
          [["A", "Alb", "One"]],
          0,
          gate,
        ),
      },
      ":memory:",
      quiet,
    );
    const job = store.create("https://open.spotify.com/playlist/x");
    // Poll as core would, while spotDL is still mid-run.
    await waitFor(() => (store.get(job.id)?.items.length ?? 0) >= 14);
    const mid = store.get(job.id)!;
    expect(mid.items).toHaveLength(14);
    expect(mid.items.filter((i) => i.state === "queued").length).toBeGreaterThan(
      0,
    );
    // The card reads "1 of 14", never "1 of 1".
    expect(mid.items.filter((i) => i.state === "completed")).toHaveLength(1);

    release();
    await waitDone(store, job.id);
    const got = store.get(job.id)!;
    expect(got.items).toHaveLength(14);
    // Nothing is left `queued` once the run is over.
    expect(got.items.some((i) => i.state === "queued")).toBe(false);
    expect(got.items.filter((i) => i.fileReady)).toHaveLength(1);
    expect(got.state).toBe("partial");
  });
});

describe("jobs are serialized so YouTube does not rate-limit us (NicotinD #601)", () => {
  it("runs one spotDL at a time and queues the rest", async () => {
    const { stage } = tmp();
    let live = 0;
    let peak = 0;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spawn = ((bin: string, args: string[], opts?: unknown) => {
      live++;
      peak = Math.max(peak, live);
      return spotdlThat(
        ["Found 1 songs in X (Playlist)", 'Downloaded "A - One": https://y/1'],
        [["A", "Alb", "One"]],
        0,
        gate.then(() => {
          live--;
        }),
      )(bin, args, opts as never);
    }) as unknown as typeof import("node:child_process").spawn;

    const store = new JobStore(stage, cfg, { spawn }, ":memory:", quiet);
    const a = store.create("https://open.spotify.com/playlist/a");
    const b = store.create("https://open.spotify.com/playlist/b");
    const c = store.create("https://open.spotify.com/playlist/c");

    // Both later jobs exist and are visible to core immediately...
    expect(store.get(b.id)).toBeTruthy();
    expect(store.get(c.id)).toBeTruthy();
    release();
    await waitDone(store, a.id);
    await waitDone(store, b.id);
    await waitDone(store, c.id);
    // ...but only one spotDL was ever alive.
    expect(peak).toBe(1);
  });

  it("cancelling a job that has not started yet never spawns spotDL", async () => {
    const { stage } = tmp();
    let spawned = 0;
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spawn = ((bin: string, args: string[], opts?: unknown) => {
      spawned++;
      return spotdlThat(
        ["Found 1 songs in X (Playlist)", 'Downloaded "A - One": https://y/1'],
        [["A", "Alb", "One"]],
        0,
        gate,
      )(bin, args, opts as never);
    }) as unknown as typeof import("node:child_process").spawn;

    const store = new JobStore(stage, cfg, { spawn }, ":memory:", quiet);
    const a = store.create("https://open.spotify.com/playlist/a");
    const b = store.create("https://open.spotify.com/playlist/b");
    // b is queued behind a, so cancelling it has no process to signal — the
    // queue must drop it rather than start it when a finishes.
    expect(store.cancel(b.id)).toBe(true);
    release();
    await waitDone(store, a.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(store.get(b.id)!.state).toBe("cancelled");
    expect(spawned).toBe(1);
  });

  it("a job that throws still lets the queue drain", async () => {
    const { stage } = tmp();
    const spawn = (() => {
      throw new Error("spawn failed");
    }) as unknown as typeof import("node:child_process").spawn;
    const store = new JobStore(stage, cfg, { spawn }, ":memory:", quiet);
    const a = store.create("https://open.spotify.com/playlist/a");
    const b = store.create("https://open.spotify.com/playlist/b");
    await waitDone(store, a.id);
    await waitDone(store, b.id);
    expect(store.get(a.id)!.state).toBe("failed");
    expect(store.get(b.id)!.state).toBe("failed");
  });
});
