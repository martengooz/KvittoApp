/** Identifier and digest helpers that work in both the browser and Node. */

/**
 * Minimal structural type for the Web Crypto API.
 *
 * Declared locally rather than pulling in `lib.dom` or `@types/node`, so this
 * package stays buildable for both the browser bundle and the server without
 * dragging either environment's globals into the other.
 */
interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues: <T extends Uint8Array>(array: T) => T;
  subtle: { digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer> };
}

const webCrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;

function requireCrypto(): WebCryptoLike {
  if (!webCrypto) {
    throw new Error('Web Crypto is unavailable; KvittoApp requires a secure context.');
  }
  return webCrypto;
}

/** RFC 4122 v4 uuid, using the platform CSPRNG. */
export function newId(): string {
  const cryptoApi = requireCrypto();
  if (cryptoApi.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Lowercase hex SHA-256 of the given bytes. Used as the content-addressed blob key. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  const digest = await requireCrypto().subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** True for a well-formed lowercase SHA-256 hex digest. */
export function isBlobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** A short, unambiguous pairing code (no vowels, no look-alike characters). */
export function newPairingCode(): string {
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXZ';
  const bytes = new Uint8Array(9);
  requireCrypto().getRandomValues(bytes);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 3).join('')}-${chars.slice(3, 6).join('')}-${chars.slice(6, 9).join('')}`;
}
