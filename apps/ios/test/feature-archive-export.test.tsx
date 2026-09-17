/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { ARCHIVE_ENTITY_KINDS } from '@kvitto/archive';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ArchiveExportScreen } from '../src/archive/export-view';
import { neverConfirm, type ConfirmPort } from '../src/ui/confirm';

import { exportArchive, type ArchiveExportSource, type ExportNativePort } from '../src/archive/export';

/**
 * Records what would be written, so the assertions are about the archive's
 * contents rather than about the native calls.
 */
function fakeNative() {
  const files = new Map<string, string>();
  const deleted: string[] = [];
  const written: { path: string; sourceFileUri: string }[] = [];
  let count = 0;

  const port: ExportNativePort = {
    makeScratchFileUri: () => `file:///scratch/${(count += 1)}.bin`,
    writeFileChunkBase64: async (uri, base64, append) => {
      const text = Buffer.from(base64, 'base64').toString('utf8');
      files.set(uri, append ? (files.get(uri) ?? '') + text : text);
      return text.length;
    },
    writeArchive: async (_destination, entries) => {
      written.push(...entries);
      return entries.length;
    },
    deleteScratchFile: async (uri) => {
      deleted.push(uri);
      return true;
    },
  };

  const contentAt = (archivePath: string): string => {
    const entry = written.find((candidate) => candidate.path === archivePath);
    if (!entry) throw new Error(`no entry at ${archivePath}. Have: ${written.map((e) => e.path).join(', ')}`);
    return files.get(entry.sourceFileUri) ?? '';
  };

  return { port, deleted, written, contentAt };
}

function makeSource(overrides: Partial<ArchiveExportSource> = {}): ArchiveExportSource {
  return {
    listEntities: async () => [],
    listBlobs: async () => [],
    getSettings: async () => ({}),
    ...overrides,
  };
}

describe('archive export', () => {
  test('writes a manifest, settings, every entity stream, and blob metadata', async () => {
    const { port, written } = fakeNative();

    const result = await exportArchive(port, makeSource(), 'file:///out.kvitto');

    const paths = written.map((entry) => entry.path);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('settings.json');
    expect(paths).toContain('blob-metadata.ndjson');
    for (const kind of ARCHIVE_ENTITY_KINDS) {
      expect(paths).toContain(`entities/${kind}.ndjson`);
    }
    expect(result.entryCount).toBe(paths.length);
  });

  test('an excluded kind still gets an empty stream, not a missing one', async () => {
    const { port, contentAt } = fakeNative();

    await exportArchive(
      port,
      makeSource({ listEntities: async () => [{ id: 'leaked', value: 'secret' }] }),
      'file:///out.kvitto',
    );

    // A missing entity stream is a preflight error, so omitting `secrets`
    // would produce an archive this app would reject.
    expect(contentAt('entities/secrets.ndjson')).toBe('');
    // And the secret rows must not be in it either.
    expect(contentAt('entities/secrets.ndjson')).not.toContain('leaked');
  });

  test('entity rows are written as NDJSON, one per line', async () => {
    const { port, contentAt } = fakeNative();

    await exportArchive(
      port,
      makeSource({
        listEntities: async (kind) =>
          kind === 'receipts' ? [{ id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' }] : [],
      }),
      'file:///out.kvitto',
    );

    const lines = contentAt('entities/receipts.ndjson').split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'r-1' });
    expect(JSON.parse(lines[2]!)).toEqual({ id: 'r-3' });
  });

  test('a stream longer than one chunk is appended, not overwritten', async () => {
    const { port, contentAt } = fakeNative();
    const rows = Array.from({ length: 500 }, (_, index) => ({ id: `r-${index}` }));

    await exportArchive(
      port,
      makeSource({ listEntities: async (kind) => (kind === 'receipts' ? rows : []) }),
      'file:///out.kvitto',
    );

    const lines = contentAt('entities/receipts.ndjson').split('\n');
    expect(lines).toHaveLength(500);
    expect(JSON.parse(lines[499]!)).toEqual({ id: 'r-499' });
  });

  test('non-ASCII content survives, because btoa alone would throw on it', async () => {
    const { port, contentAt } = fakeNative();

    await exportArchive(
      port,
      makeSource({
        listEntities: async (kind) => (kind === 'receipts' ? [{ merchant: 'Kött & Bröd åäö' }] : []),
      }),
      'file:///out.kvitto',
    );

    expect(contentAt('entities/receipts.ndjson')).toContain('Kött & Bröd åäö');
  });

  test('settings are redacted with the same rules the web export uses', async () => {
    const { port, contentAt } = fakeNative();

    await exportArchive(
      port,
      makeSource({
        getSettings: async () => ({
          // One allowed field, so this test cannot pass just because
          // redaction emptied the object.
          scan: { autoCapture: true, jpegQuality: 0.8 },
          aiApiKey: 'sk-should-not-be-here',
          pairingToken: 'token-should-not-be-here',
          deviceId: 'device-should-not-be-here',
        }),
      }),
      'file:///out.kvitto',
    );

    const settings = contentAt('settings.json');
    expect(settings).not.toContain('sk-should-not-be-here');
    expect(settings).not.toContain('token-should-not-be-here');
    expect(settings).not.toContain('device-should-not-be-here');
    expect(JSON.parse(settings)).toMatchObject({ scan: { autoCapture: true } });
  });

  test('blobs are referenced by file, never read into JavaScript', async () => {
    const { port, written, contentAt } = fakeNative();

    const result = await exportArchive(
      port,
      makeSource({
        listBlobs: async () => [
          {
            sha256: 'a'.repeat(64),
            mimeType: 'image/jpeg',
            width: 100,
            height: 200,
            sizeBytes: 4096,
            role: 'processed',
            fileUri: 'file:///blobs/aa/aa/live-file.jpg',
          },
        ],
      }),
      'file:///out.kvitto',
    );

    const blobEntry = written.find((entry) => entry.path === `blobs/${'a'.repeat(64)}`);
    expect(blobEntry?.sourceFileUri).toBe('file:///blobs/aa/aa/live-file.jpg');
    expect(result.blobCount).toBe(1);

    const metadata = JSON.parse(contentAt('blob-metadata.ndjson')) as Record<string, unknown>;
    expect(metadata).toMatchObject({ sha256: 'a'.repeat(64), sizeBytes: 4096, role: 'processed' });
  });

  test('staged files are cleaned up, and live blob files are not touched', async () => {
    const { port, deleted } = fakeNative();

    await exportArchive(
      port,
      makeSource({
        listBlobs: async () => [
          {
            sha256: 'b'.repeat(64),
            mimeType: 'image/jpeg',
            width: 1,
            height: 1,
            sizeBytes: 1,
            role: 'processed',
            fileUri: 'file:///blobs/bb/bb/live-file.jpg',
          },
        ],
      }),
      'file:///out.kvitto',
    );

    expect(deleted.length).toBeGreaterThan(0);
    // Deleting a live blob would destroy user data.
    expect(deleted).not.toContain('file:///blobs/bb/bb/live-file.jpg');
  });

  test('staged files are cleaned up even when writing the archive fails', async () => {
    const { port, deleted } = fakeNative();
    const failing: ExportNativePort = {
      ...port,
      writeArchive: async () => {
        throw new Error('disk full');
      },
    };

    await expect(exportArchive(failing, makeSource(), 'file:///out.kvitto')).rejects.toThrow('disk full');
    expect(deleted.length).toBeGreaterThan(0);
  });
});

describe('export screen warns before writing', () => {
  test('declining the warning writes nothing', async () => {
    const { port, written } = fakeNative();

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ArchiveExportScreen
          native={port}
          source={makeSource()}
          destinationUri="file:///out.kvitto"
          confirm={neverConfirm}
        />,
      );
    });

    const button = renderer!.root.findAll(
      (node) => node.props?.accessibilityLabel === 'Export archive' && typeof node.props?.onPress === 'function',
    );
    await act(async () => {
      (button[button.length - 1]!.props as { onPress: () => void }).onPress();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Section 14 requires the warning; it has to be a gate, not a notice.
    expect(written).toEqual([]);
    await act(async () => renderer!.unmount());
  });

  test('the warning names the risk rather than asking "are you sure"', async () => {
    const { port } = fakeNative();

    const prompts: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ArchiveExportScreen
          native={port}
          source={makeSource()}
          destinationUri="file:///out.kvitto"
          confirm={((request) => {
            prompts.push(`${request.title} ${request.message}`);
            return Promise.resolve(false);
          }) satisfies ConfirmPort}
        />,
      );
    });

    const button = renderer!.root.findAll(
      (node) => node.props?.accessibilityLabel === 'Export archive' && typeof node.props?.onPress === 'function',
    );
    await act(async () => {
      (button[button.length - 1]!.props as { onPress: () => void }).onPress();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('not password-protected');
    await act(async () => renderer!.unmount());
  });
});
