import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeSpawn } from "./resolve.test.js";
import { JobStore } from "./job-store.js";
import { createServer } from "./server.js";

const TOKEN = "test-token";

// A spotDL that writes one file then exits 0 — the job completes to `done`.
function spawnOneFile() {
  return ((bin: string, args: string[], o?: unknown) => {
    const outIdx = args.indexOf("--output");
    const base = args[outIdx + 1]!.split("{artist}")[0]!;
    return fakeSpawn({
      lines: ['Downloaded "A - Song": u'],
      writeTo: () => {
        mkdirSync(join(base, "A", "B"), { recursive: true });
        writeFileSync(join(base, "A", "B", "Song.mp3"), "audio");
      },
    })(bin, args, o as never);
  }) as unknown as typeof import("node:child_process").spawn;
}

function makeApp(spawn = spawnOneFile()) {
  const stage = join(tmpdir(), `sps-${process.pid}-${Date.now()}`);
  const jobs = new JobStore(
    stage,
    () => ({ binaryPath: "spotdl" }),
    { spawn },
    ":memory:",
    () => {},
  );
  return createServer({ token: TOKEN, jobs });
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("spotdl addon server", () => {
  it("serves the manifest unauthenticated with the spotify.com pattern at default priority", async () => {
    const res = await makeApp().request("/addon/v1/manifest");
    expect(res.status).toBe(200);
    const m = (await res.json()) as {
      id: string;
      priority?: number;
      urlPatterns: string[];
    };
    expect(m.id).toBe("spotdl-addon");
    // No explicit priority → default 0, which beats yt-dlp's -10 catch-all.
    expect(m.priority).toBeUndefined();
    expect(m.urlPatterns).toContain("spotify\\.com");
  });

  it("401s a jobs call without the bearer token", async () => {
    const res = await makeApp().request("/addon/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        intent: "url",
        url: "https://open.spotify.com/album/x",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("resolves a url job → fileReady item → serves the bytes", async () => {
    const app = makeApp();
    const created = await app.request("/addon/v1/jobs", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "url",
        url: "https://open.spotify.com/album/x",
      }),
    });
    expect(created.status).toBe(201);
    const { job } = (await created.json()) as { job: { id: string } };

    // Poll until the background resolve completes.
    let done:
      | {
          id: string;
          state: string;
          items: Array<{ itemId: string; fileReady: boolean }>;
        }
      | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await app.request(`/addon/v1/jobs/${job.id}`, {
        headers: auth,
      });
      const body = (await res.json()) as { job: typeof done };
      if (body.job && body.job.state !== "active") {
        done = body.job;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(done?.state).toBe("done");
    expect(done?.items[0]?.fileReady).toBe(true);

    const file = await app.request(
      `/addon/v1/jobs/${job.id}/files/${encodeURIComponent(done!.items[0]!.itemId)}`,
      { headers: auth },
    );
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("audio");
  });

  // Core's `POST jobs/:id/cancel` used to 404 here — the route did not exist —
  // so "Cancel" on a running Spotify download read as an addon error.
  it("cancels a running job, and 404s an unknown one", async () => {
    const app = makeApp(fakeSpawn({ hang: true }));
    const created = await app.request("/addon/v1/jobs", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "url",
        url: "https://open.spotify.com/album/x",
      }),
    });
    const { job } = (await created.json()) as { job: { id: string } };
    const cancelled = await app.request(`/addon/v1/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: auth,
    });
    expect(cancelled.status).toBe(200);
    const after = await app.request(`/addon/v1/jobs/${job.id}`, {
      headers: auth,
    });
    expect(((await after.json()) as { job: { state: string } }).job.state).toBe(
      "cancelled",
    );
    const missing = await app.request("/addon/v1/jobs/nope/cancel", {
      method: "POST",
      headers: auth,
    });
    expect(missing.status).toBe(404);
  });
});
