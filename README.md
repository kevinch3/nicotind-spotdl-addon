# nicotind-spotdl-addon

The **spotDL acquisition addon** for [NicotinD](https://github.com/kevinch3/NicotinD) — an
out-of-process HTTP addon speaking the **acquisition addon protocol v1**. It resolves audio from
Spotify track/album/playlist URLs by matching their metadata with
[spotDL](https://github.com/spotDL/spotify-downloader) (which downloads the audio from YouTube).

Core carries no spotDL code; register this addon by URL + token under **Extensions**. It declares
`urlPatterns: ['spotify\\.com']` at the **default** priority, so it wins Spotify URLs while the
yt-dlp catch-all addon (`priority: -10`) still handles everything else.

## How it works

`POST /addon/v1/jobs {intent:'url', url}` spawns `spotdl download`, downloading into the addon's
storage, and **reads its output as it runs** (`--simple-tui --log-level INFO --print-errors`, parsed
with `@nicotind/addon-sdk`'s `downloader-output` parsers): the list's name becomes the job's `title`,
every `Downloaded` / `Skipping` / failed-song line becomes one item **in that order**, and when spotDL
announced more songs than it ever reported (it died partway) the remainder are `unavailable`
placeholders — so a 1-of-16 playlist reads "1 of 16", `partial`, with spotDL's own error lines, not a
clean "Done 1 of 1" (NicotinD #585; the addon used to run with `stdio: 'ignore'` and glob staging).
Every spotDL line is also written to the addon's log, so `docker logs` has the transcript. Landed
files are paired to reported tracks by `<artist dir> - <stem>` ≙ `Artist - Title`. Items flip
`fileReady` and the bytes are served from `GET /addon/v1/jobs/:id/files/:itemId` — core's
`AddonJobPoller` fetches them and runs the same organize → scan pipeline every source uses.
`POST /addon/v1/jobs/:id/cancel` SIGTERMs spotDL and closes the job `cancelled`. spotDL uses yt-dlp under the hood, so YouTube bot-checks
are mitigated by the **bgutil PO-token provider** run as a **sidecar** (the image bakes the paired
`bgutil-ytdlp-pot-provider` plugin; spotDL can't thread extractor-args, so the sidecar must be
reachable at the plugin's default `127.0.0.1:4416` — share the network namespace).

The image pins **yt-dlp to the PyPI version current at build time** (`--build-arg YTDLP_VERSION`,
resolved by CI). It used to be "latest", which a cached Docker layer silently froze for weeks while
YouTube moved on — every media fetch 403'd (NicotinD #588). Rebuild the image to pick up a newer
yt-dlp; a local build needs the arg: `docker build --build-arg YTDLP_VERSION=$(curl -fsS https://pypi.org/pypi/yt-dlp/json | python3 -c 'import sys,json;print(json.load(sys.stdin)["info"]["version"])') .`

## Run (Docker)

```bash
docker run -d --name spotdl-addon \
  -p 8587:8587 \
  -v /srv/spotdl-addon:/data \
  -e SPOTDL_ADDON_TOKEN=<a-long-random-secret> \
  ghcr.io/kevinch3/nicotind-spotdl-addon:latest
```

Then in NicotinD → **Extensions → Add addon**, register `http://<host>:8587` with the same token.

## Configuration

| Env var                      | Required | Default           | Purpose                                                   |
| ---------------------------- | -------- | ----------------- | --------------------------------------------------------- |
| `SPOTDL_ADDON_TOKEN`         | **yes**  | —                 | Bearer token core authenticates with                      |
| `SPOTDL_ADDON_CLIENT_ID`     | —        | —                 | Spotify Client ID (raises spotDL's rate limits; optional) |
| `SPOTDL_ADDON_CLIENT_SECRET` | —        | —                 | Spotify Client Secret (optional)                          |
| `SPOTDL_ADDON_BINARY`        | —        | `spotdl`          | spotdl binary path                                        |
| `SPOTDL_ADDON_COOKIES`       | —        | —                 | Netscape cookies.txt path (unblocks a flagged IP)         |
| `SPOTDL_ADDON_THREADS`       | —        | `2`               | spotDL's per-job download fan-out (clamped to 1..8)       |
| `SPOTDL_ADDON_DOWNLOADS_DIR` | —        | `/data/downloads` | staging dir                                               |
| `SPOTDL_ADDON_PORT`          | —        | `8587`            | HTTP listen port                                          |

Only `GET /addon/v1/manifest` + `/health` are unauthenticated; every other route needs the bearer token.

## One job at a time, and a capped fan-out

Jobs are **serialized**: `create` returns an `active` job immediately and queues the run, and only
one `spotdl` process is ever alive. Each one's own thread pool is capped too (`--threads`, default
**2**, `SPOTDL_ADDON_THREADS`).

Both halves are needed, and neither is a micro-optimisation. The addon used to spawn every job the
moment it arrived, and spotDL's default pool is 4 — so importing three playlists meant ~12 concurrent
YouTube fetches from one IP. YouTube rate-limited the reference deployment down to **~9 % success**
(NicotinD #601: over 12 h, 134 downloads against 793 "no usable results" + 485 yt-dlp errors + 173
`JSONDecodeError`), and the failures name songs YouTube Music certainly has. The symptom reads like
"the track isn't available" and is not: `yt-dlp` was current and a direct fetch of a *failing* URL
succeeded. Serializing alone would still leave 4 in flight; capping alone would still stack N jobs.

A playlist import is not latency-sensitive, so waiting costs the user nothing — a queued job is
`active` and visible to core's poll from creation. Serializing does make one state reachable that
never was before: a job **cancelled before it started**, which has no process to signal. The queue
drops it rather than spawning spotDL for a download the user already closed.

## A throttled preflight retries instead of crashing the whole job

Serializing jobs fixed the *concurrency* half of #601, but a re-measure on prod (2026-08-23,
issue #651) found the per-job success rate unchanged at **~9 %** — the fix moved the needle on
symptom 2 (unavailable rate) not at all, because symptom 1 was still unbuilt. spotDL's own
preflight (`check_ytmusic_connection`, called before it resolves a single track) crashes with a
bare `JSONDecodeError` the moment YouTube Music returns one throttled, non-JSON response — the
*whole job* dies with zero files and a raw Python traceback as its only output, before track 1.
One playlist in the re-measure sample hit exactly this: `0 of 0`, nothing attempted.

`runSpotdlWithRetry` (`resolve.ts`) wraps `runSpotdl` and retries the **whole process** —
spotDL never gets far enough to retry internally — on that one specific signature
(`isPreflightThrottleCrash`: zero files landed + that exact traceback tail), with exponential
backoff and full jitter, up to 3 attempts total. Every other outcome (success, an honest
partial playlist, any other crash) returns on the first attempt unchanged, so this cannot turn
a real "nothing here" into a duplicate run. `JobStore` calls this instead of `runSpotdl` and
needs no other change — same `RunningResolve` shape, `cancel()` still works mid-attempt or
mid-backoff.

## A transient per-track failure gets a bounded second try

Item A retries a job that dies before track 1. Item C (#651) covers the far more common case: a
job that gets partway through and leaves some tracks behind. `classifyTrackFailure` (shared with
the Downloads card, via `@nicotind/addon-sdk`) already knows which of those are worth retrying —
`transient` (a throttled search or a refused fetch) versus `unknown` (the source may genuinely not
have it, and under throttling that line is indistinguishable from a rate-limited miss either way).

`JobStore.run` gives every `transient` failure up to **2** more passes, batched — every still-
failing URL from one pass in a single spotDL invocation, not one call per track. That's not a
minor optimisation: every spotDL invocation redoes YouTube Music's own preflight check
(`check_ytmusic_connection`) regardless of how many tracks it's asked for, so N single-track
retries would cost N extra requests against the exact throttle this exists to relieve.

A batched retry pass forces `--threads 1`. That's what makes it safe: spotDL's own thread pool
can otherwise interleave a multi-query run's per-track events, and nothing in a job's `items`
records which query a given event belongs to — only *arrival order matching query order*, which
sequential processing guarantees and concurrent processing does not. `unknown`-class failures are
never touched; the loop stops the moment nothing left is `transient`, or after 2 passes, whichever
comes first.

## The announced total is honest from the first poll

spotDL prints `Found N songs` up front but reports tracks one at a time. The addon now pushes `N`
**`queued` placeholders** the moment that total is announced, and each track claims one as it lands;
anything still `queued` when the run ends becomes `unavailable`. Without this the card's denominator
grew under the user — `0 of 1` → `2 of 14` → `7 of 32` — which reads as the download *changing its
mind* about how big it is (NicotinD #595).

## Develop

```bash
bun install
bun run typecheck   # tsc --build
bun run test        # bun:test — resolve engine (injected spawner) + protocol server
```

> The addon depends on `@nicotind/addon-sdk`. The `url` job intent it uses shipped in core but is
> pending in the published SDK; once `@nicotind/addon-sdk@^0.1.1` is out, bump the dep and drop the
> one `as unknown as` cast in `src/job-store.ts`.

## License

AGPL-3.0-only, matching NicotinD.
