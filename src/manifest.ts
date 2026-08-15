/**
 * The spotDL addon's protocol manifest. Served verbatim as JSON from
 * `GET /addon/v1/manifest`. It declares `urlPatterns: ['spotify\\.com']` at the
 * default priority (0), so it beats the yt-dlp catch-all (`priority: -10`) for
 * Spotify URLs while every other URL still falls through to yt-dlp.
 *
 * Spotify Client ID/Secret are OPTIONAL config: spotDL works without them (its
 * built-in shared client), and raises its rate limits when they're supplied. The
 * authoritative source is the addon's env (SPOTDL_ADDON_CLIENT_ID/SECRET); the
 * configFields are declared for parity with the yt-dlp addon.
 */
export const SPOTDL_MANIFEST = {
  id: 'spotdl-addon',
  name: 'spotDL',
  description: 'Download audio from Spotify track/album/playlist URLs (matched via spotDL).',
  version: '0.1.0',
  protocolVersion: '1.0.0',
  kind: 'acquisition',
  capabilities: ['resolve'],
  urlPatterns: ['spotify\\.com'],
  configFields: [
    { key: 'binaryPath', label: 'spotdl binary path', type: 'text' },
    { key: 'cookiesFile', label: 'Cookies file (Netscape format) path', type: 'text' },
    { key: 'clientId', label: 'Spotify Client ID (optional)', type: 'text' },
    { key: 'clientSecret', label: 'Spotify Client Secret (optional)', type: 'password' },
  ],
  compliance: {
    disclaimer:
      'spotDL matches Spotify metadata to audio downloaded from YouTube. You are responsible ' +
      'for complying with the relevant Terms of Service and with copyright law in your jurisdiction.',
    requiresConsent: true,
  },
} as const;
