import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCompressionStreamZipSink,
  getArchiveExportCapability,
  supportsZipCompressionStream,
} from '../src/migration/archive-export-browser-core.ts';

void test('capability is disabled without codec or injected sink', () => {
  const capability = getArchiveExportCapability({
    codecAvailable: false,
    sinkFactory: null,
  });

  assert.equal(capability.supported, false);
  assert.equal(capability.mode, null);
  assert.ok(capability.reason?.includes('saknar ZIP-komprimering'));
});

void test('capability is enabled by an injected sink even without codec', () => {
  const capability = getArchiveExportCapability({
    codecAvailable: false,
    sinkFactory: () => ({
      addEntry: async () => {},
      close: async () => new Blob([]),
    }),
  });

  assert.equal(capability.supported, true);
  assert.equal(capability.mode, 'injected-sink');
});

void test(
  'compression stream sink writes a ZIP structure',
  { skip: !supportsZipCompressionStream() },
  async () => {
    const sink = createCompressionStreamZipSink(new Date('2026-09-16T00:00:00.000Z'));

    let yielded = 0;
    await sink.addEntry(
      'manifest.json',
      (async function* entries(): AsyncIterable<Uint8Array> {
        yielded += 1;
        yield new TextEncoder().encode('{"format":"kvitto-archive"}');
      })(),
    );

    const blob = await sink.close();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Local file header.
    assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);

    // End of central directory should be present in a tiny single-entry archive.
    let eocdFound = false;
    for (let i = 0; i <= bytes.length - 4; i += 1) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x05 &&
        bytes[i + 3] === 0x06
      ) {
        eocdFound = true;
        break;
      }
    }

    assert.equal(eocdFound, true);
    assert.equal(yielded, 1);
  },
);
