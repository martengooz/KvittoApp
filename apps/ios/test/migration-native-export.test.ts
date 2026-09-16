import { describe, expect, test } from '@jest/globals';
import { preflightArchive, type ArchiveEntrySource } from '@kvitto/archive';

import { createNativeArchiveFacade, NativeArchiveZipWiringGapError } from '../modules/kvitto-native/src/archive';
import { buildNativeExportPlan, writeArchiveExportToZipWriter } from '../src/migration/exporter';
import type { FileBackedZipWriter } from '../src/migration/types';
import { sha256Hex } from './migration-fixtures';

class InMemoryZipWriter implements FileBackedZipWriter {
  private readonly files = new Map<string, Uint8Array>();

  async addEntry(path: string, bytes: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of bytes) chunks.push(chunk);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.files.set(path, joined);
  }

  async close(): Promise<AsyncIterable<Uint8Array>> {
    const manifest = Array.from(this.files.entries()).map(([path, bytes]) => ({ path, bytes: Array.from(bytes) }));
    const payload = new TextEncoder().encode(JSON.stringify(manifest));
    return (async function* stream(): AsyncIterable<Uint8Array> {
      yield payload;
    })();
  }

  toEntrySource(): ArchiveEntrySource {
    const snapshot = Array.from(this.files.entries());
    return {
      entries: async function* entries() {
        for (const [path, bytes] of snapshot) {
          yield {
            path,
            uncompressedSize: bytes.byteLength,
            open: async function* open() {
              yield bytes;
            },
          };
        }
      },
    };
  }
}

describe('migration native export plan', () => {
  test('writes export entries that validate with shared archive preflight', async () => {
    const writer = new InMemoryZipWriter();
    const blobBytes = new Uint8Array([7, 8, 9]);
    const blobId = sha256Hex(blobBytes);

    await writeArchiveExportToZipWriter(writer, {
      getRedactedSettings: async () => ({
        scan: { autoCapture: true, jpegQuality: 0.8, colorMode: 'grayscale' },
        ocr: { languages: ['sv-SE'], languageCorrection: true },
        sync: { autoSync: true, wifiOnly: false },
        ui: { locale: 'sv-SE', currency: 'SEK', compactList: true },
        ai: { mode: 'none', provider: 'none' },
      }),
      listEntities: async () => [],
      listBlobs: async () => [
        {
          id: blobId,
          mimeType: 'image/jpeg',
          byteSize: 3,
          width: 1,
          height: 1,
          role: 'processed',
          open: async function* open() {
            yield blobBytes;
          },
        },
      ],
    });

    const report = await preflightArchive(writer.toEntrySource());
    expect(report.ok).toBe(true);
    expect(report.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  });

  test('exposes explicit native wiring gap instead of pretending ZIP support', async () => {
    const facade = createNativeArchiveFacade({});
    const plan = buildNativeExportPlan({
      supported: false,
      mode: 'missing-wiring',
      reason: 'Native ZIP not bridged yet.',
    });

    expect(plan.capability.supported).toBe(false);
    await expect(facade.openZipIndex('file:///tmp/archive.kvitto')).rejects.toBeInstanceOf(
      NativeArchiveZipWiringGapError,
    );
  });
});
