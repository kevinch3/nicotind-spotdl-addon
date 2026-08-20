import { Hono } from "hono";
import { SPOTDL_MANIFEST } from "./manifest.js";
import type { JobStore } from "./job-store.js";

export interface ServerDeps {
  token: string;
  jobs: JobStore;
}

/**
 * The acquisition addon protocol v1 surface. `manifest` + `health` are
 * unauthenticated; everything else requires the bearer token core registered
 * with. Resolve jobs are `{intent:'url', url}` → the JobStore.
 */
export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  app.get("/addon/v1/manifest", (c) => c.json(SPOTDL_MANIFEST));
  app.get("/addon/v1/health", (c) => c.json({ ok: true, ready: true }));

  // Bearer guard for everything except manifest/health.
  app.use("/addon/v1/*", async (c, next) => {
    const path = c.req.path;
    if (path === "/addon/v1/manifest" || path === "/addon/v1/health")
      return next();
    if (c.req.header("authorization") !== `Bearer ${deps.token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  });

  app.get("/addon/v1/status", (c) => c.json([]));
  app.put("/addon/v1/config", (c) => c.body(null, 204));

  app.post("/addon/v1/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      intent?: string;
      url?: string;
    };
    if (body.intent !== "url" || !body.url) {
      return c.json(
        { error: "spotdl-addon only handles url jobs with a url" },
        400,
      );
    }
    return c.json({ job: deps.jobs.create(body.url) }, 201);
  });

  app.get("/addon/v1/jobs", (c) => {
    const since = Number(c.req.query("since") ?? "0") || 0;
    return c.json({ jobs: deps.jobs.list(since) });
  });

  app.get("/addon/v1/jobs/:id", (c) => {
    const job = deps.jobs.get(c.req.param("id"));
    return job ? c.json({ job }) : c.json({ error: "not found" }, 404);
  });

  app.post("/addon/v1/jobs/:id/cancel", (c) => {
    const id = c.req.param("id");
    if (!deps.jobs.get(id)) return c.json({ error: "not found" }, 404);
    deps.jobs.cancel(id);
    return c.json({ ok: true });
  });

  app.delete("/addon/v1/jobs/:id", (c) => {
    deps.jobs.remove(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/addon/v1/jobs/:id/files/:itemId", (c) => {
    const path = deps.jobs.filePath(
      c.req.param("id"),
      decodeURIComponent(c.req.param("itemId")),
    );
    if (!path) return c.json({ error: "not found" }, 404);
    return new Response(Bun.file(path));
  });

  return app;
}
