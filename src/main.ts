import { JobStore } from './job-store.js';
import { createServer } from './server.js';
import type { SpotdlConfig } from './resolve.js';

const token = process.env.SPOTDL_ADDON_TOKEN;
if (!token) {
  console.error('SPOTDL_ADDON_TOKEN is not set — refusing to start without an access token');
  process.exit(1);
}

const config = (): SpotdlConfig => ({
  binaryPath: process.env.SPOTDL_ADDON_BINARY ?? 'spotdl',
  cookiesFile: process.env.SPOTDL_ADDON_COOKIES || undefined,
  // Optional — raise spotDL's Spotify rate limits over its shared client.
  clientId: process.env.SPOTDL_ADDON_CLIENT_ID || undefined,
  clientSecret: process.env.SPOTDL_ADDON_CLIENT_SECRET || undefined,
});

const stagingBase = process.env.SPOTDL_ADDON_DOWNLOADS_DIR ?? '/data/downloads';
const port = Number(process.env.SPOTDL_ADDON_PORT ?? '8587');

const jobs = new JobStore(stagingBase, config);
const app = createServer({ token, jobs });

console.log(`spotDL addon listening on :${port}`);
export default { port, fetch: app.fetch };
