import type { DigestImplementation } from './types.js';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

async function collectChunks(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    parts.push(chunk);
    total += chunk.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function getWebCrypto(): { subtle: { digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer> } } {
  const maybeCrypto = (globalThis as { crypto?: unknown }).crypto;
  if (!maybeCrypto || typeof maybeCrypto !== 'object') {
    throw new Error('Web Crypto is unavailable. Inject a digest implementation for this runtime.');
  }

  const subtle = (maybeCrypto as { subtle?: unknown }).subtle;
  if (!subtle || typeof subtle !== 'object') {
    throw new Error('Web Crypto subtle API is unavailable. Inject a digest implementation for this runtime.');
  }

  const digest = (subtle as { digest?: unknown }).digest;
  if (typeof digest !== 'function') {
    throw new Error('Web Crypto subtle.digest is unavailable. Inject a digest implementation for this runtime.');
  }

  return { subtle: subtle as { digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer> } };
}

export const webCryptoDigest: DigestImplementation = {
  async sha256Hex(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    const bytes = await collectChunks(chunks);
    const cryptoApi = getWebCrypto();
    const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
    const result = await cryptoApi.subtle.digest('SHA-256', input as ArrayBuffer);
    return toHex(new Uint8Array(result));
  },
};
