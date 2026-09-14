import assert from 'node:assert/strict';
import { test } from 'node:test';

test('hashes when crypto.subtle is unavailable', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues<T extends Uint8Array>(array: T): T {
        return array;
      },
    },
  });

  try {
    const { sha256Hex } = await import(`../dist/ids.js?without-subtle=${Date.now()}`);
    const digest = await sha256Hex(new TextEncoder().encode('abc'));

    assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    } else {
      delete (globalThis as { crypto?: unknown }).crypto;
    }
  }
});