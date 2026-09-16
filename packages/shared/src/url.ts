/**
 * Base-URL handling shared by everything that talks to a configurable host.
 *
 * A user pastes `http://localhost:11434/` as readily as `http://localhost:11434`,
 * so every caller that joins a path onto a base has to strip the trailing slash
 * first or send a request to a doubled `//`. That strip was written out in
 * eleven places — the AI providers, the sync client, the company lookup, the
 * server's own proxy and dashboard.
 */

/** Trims trailing slashes so a path can be appended directly. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Whether a host is the machine the code is running on.
 *
 * Used to decide when an unencrypted connection is acceptable and when an
 * endpoint may skip authentication — so the check is deliberately exact rather
 * than a prefix match: `localhost.example.com` is not loopback.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
