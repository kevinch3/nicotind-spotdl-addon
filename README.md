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
storage. Items flip `fileReady` and the bytes are served from
`GET /addon/v1/jobs/:id/files/:itemId` — core's `AddonJobPoller` fetches them and runs the same
organize → scan pipeline every source uses. spotDL uses yt-dlp under the hood, so YouTube bot-checks
are mitigated by the **bgutil PO-token provider** run as a **sidecar** (the image bakes the paired
`bgutil-ytdlp-pot-provider` plugin; spotDL can't thread extractor-args, so the sidecar must be
reachable at the plugin's default `127.0.0.1:4416` — share the network namespace).

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

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SPOTDL_ADDON_TOKEN` | **yes** | — | Bearer token core authenticates with |
| `SPOTDL_ADDON_CLIENT_ID` | — | — | Spotify Client ID (raises spotDL's rate limits; optional) |
| `SPOTDL_ADDON_CLIENT_SECRET` | — | — | Spotify Client Secret (optional) |
| `SPOTDL_ADDON_BINARY` | — | `spotdl` | spotdl binary path |
| `SPOTDL_ADDON_COOKIES` | — | — | Netscape cookies.txt path (unblocks a flagged IP) |
| `SPOTDL_ADDON_DOWNLOADS_DIR` | — | `/data/downloads` | staging dir |
| `SPOTDL_ADDON_PORT` | — | `8587` | HTTP listen port |

Only `GET /addon/v1/manifest` + `/health` are unauthenticated; every other route needs the bearer token.

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
