import { getRandomValues, randomUUID } from 'expo-crypto';

/**
 * Hermes ships no Web Crypto, but `@kvitto/shared` reads `globalThis.crypto`
 * once at module load to generate ids. This must therefore run before anything
 * imports shared code, which is why the app entry point loads it first.
 *
 * Only the CSPRNG is polyfilled. `sha256Hex` already falls back to a pure-JS
 * SHA-256 when `crypto.subtle` is absent, and a hand-rolled `subtle` would risk
 * corrupting content-addressed blob ids for no gain.
 */
function installWebCrypto(): void {
  const existing = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (existing?.getRandomValues) return;

  Object.defineProperty(globalThis, 'crypto', {
    value: { ...existing, getRandomValues, randomUUID },
    configurable: true,
    writable: true,
  });
}

installWebCrypto();
