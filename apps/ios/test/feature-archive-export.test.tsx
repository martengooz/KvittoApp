/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { ARCHIVE_ENTITY_KINDS } from '@kvitto/archive';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ArchiveExportScreen } from '../src/archive/export-view';
import { alwaysConfirm, neverConfirm, type ConfirmPort } from '../src/ui/confirm';

import { exportArchive, type ArchiveExportSource, type ExportNativePort } from '../src/archive/export';

/**
 * Records what would be written, so the assertions are about the archive's
 * contents rather than about the native calls.
 */
function fakeNative() {
  const files = new Map<string, string>();
  const deleted: string[] = [];
  const written: { path: string; sourceFileUri: string }[] = [];
  const shared: string[] = [];
  let count = 0;
  let shareOutcome: () => Promise<boolean> | boolean = () => true;

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
    shareFile: async (uri) => {
      shared.push(uri);
      return shareOutcome();
    },
  };

  const contentAt = (archivePath: string): string => {
    const entry = written.find((candidate) => candidate.path === archivePath);
    if (!entry) throw new Error(`no entry at ${archivePath}. Have: ${written.map((e) => e.path).join(', ')}`);
    return files.get(entry.sourceFileUri) ?? '';
  };

  return {
    port,
    deleted,
    written,
    shared,
    contentAt,
    setShareOutcome: (next: () => Promise<boolean> | boolean) => {
      shareOutcome = next;
    },
  };
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

describe('an exported archive can leave the app', () => {
  /*
   * The export writes into the app's own caches directory. Before sharing
   * existed, the screen reported that path and stopped, which read as success
   * while leaving the user with a file nothing on the phone could open.
   */
  const press = async (renderer: ReactTestRenderer, label: string): Promise<void> => {
    const matches = renderer.root.findAll(
      (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
    );
    if (matches.length === 0) throw new Error(`no pressable labelled "${label}"`);
    await act(async () => {
      (matches[matches.length - 1]!.props as { onPress: () => void }).onPress();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const labels = (renderer: ReactTestRenderer): string[] =>
    renderer.root
      .findAll((node) => typeof node.props?.accessibilityLabel === 'string')
      .map((node) => String(node.props.accessibilityLabel));

  const summaries = (renderer: ReactTestRenderer): string =>
    renderer.root
      .findAll((node) => node.props?.accessibilityRole === 'summary')
      .map((node) => {
        const children: unknown = node.props.children;
        return (Array.isArray(children) ? children : [children]).map((child) => String(child)).join('');
      })
      .join(' ');

  const render = async (native: ExportNativePort): Promise<ReactTestRenderer> => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ArchiveExportScreen
          native={native}
          source={makeSource()}
          destinationUri="file:///out.kvitto"
          confirm={alwaysConfirm}
        />,
      );
    });
    return renderer!;
  };

  test('there is nothing to share until an export has produced something', async () => {
    const { port } = fakeNative();
    const renderer = await render(port);

    expect(labels(renderer)).not.toContain('Save or send the file');
    await act(async () => renderer.unmount());
  });

  test('a completed export offers to hand the file to the share sheet', async () => {
    const { port, shared } = fakeNative();
    const renderer = await render(port);

    await press(renderer, 'Export archive');
    expect(labels(renderer)).toContain('Save or send the file');

    await press(renderer, 'Save or send the file');

    // The file it shares must be the one just written, not the scratch staging
    // files the export used on the way.
    expect(shared).toEqual(['file:///out.kvitto']);
    expect(summaries(renderer)).toContain('left the app');
    await act(async () => renderer.unmount());
  });

  test('dismissing the share sheet is reported, not treated as saved', async () => {
    /*
     * The sheet reports a dismissal as an ordinary outcome. Leaving the earlier
     * "exported" message standing would tell someone their data was safely out
     * of the app when it never left.
     */
    const harness = fakeNative();
    harness.setShareOutcome(() => false);
    const renderer = await render(harness.port);

    await press(renderer, 'Export archive');
    await press(renderer, 'Save or send the file');

    expect(summaries(renderer)).toContain('Not saved yet');
    expect(summaries(renderer)).not.toContain('left the app');
    await act(async () => renderer.unmount());
  });

  test('a share that fails says so and leaves the offer standing', async () => {
    const harness = fakeNative();
    harness.setShareOutcome(() => Promise.reject(new Error('no visible screen to present from')));
    const renderer = await render(harness.port);

    await press(renderer, 'Export archive');
    await press(renderer, 'Save or send the file');

    const alerts = renderer.root
      .findAll((node) => node.props?.accessibilityRole === 'alert')
      .map((node) => String(node.props.children));
    expect(alerts.join(' ')).toContain('no visible screen');
    // Still offered: the archive is written and retrying costs nothing.
    expect(labels(renderer)).toContain('Save or send the file');
    await act(async () => renderer.unmount());
  });

  test('the success message no longer points at a path nobody can open', async () => {
    const { port } = fakeNative();
    const renderer = await render(port);

    await press(renderer, 'Export archive');

    expect(summaries(renderer)).not.toContain('file:///');
    await act(async () => renderer.unmount());
  });
});

describe('the launch-environment driver stays out of the way', () => {
  const renderWith = async (
    native: ExportNativePort,
    props: { launchAction?: string } = {},
  ): Promise<ReactTestRenderer> => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ArchiveExportScreen
          native={native}
          source={makeSource()}
          destinationUri="file:///out.kvitto"
          confirm={neverConfirm}
          {...props}
        />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return renderer!;
  };

  test('a normal launch exports nothing at all', async () => {
    /*
     * This screen writes every receipt and image on the device into one
     * unencrypted file. Doing that because someone opened the screen - or
     * because a default crept into the launch verb - would be a data leak, not
     * a bug, so the inert case is pinned here rather than left implied.
     */
    const { port, written, shared } = fakeNative();

    const renderer = await renderWith(port);

    expect(written).toEqual([]);
    expect(shared).toEqual([]);
    await act(async () => renderer.unmount());
  });

  test('an unrecognised verb exports nothing either', async () => {
    const { port, written, shared } = fakeNative();

    const renderer = await renderWith(port, { launchAction: 'export' });

    expect(written).toEqual([]);
    expect(shared).toEqual([]);
    await act(async () => renderer.unmount());
  });

  test('the real verb exports and opens the sheet without a person confirming', async () => {
    // `neverConfirm` here on purpose: the driver must not be answering the
    // warning prompt, it must be a path that does not reach it.
    const { port, written, shared } = fakeNative();

    const renderer = await renderWith(port, { launchAction: 'export-and-share' });

    expect(written.length).toBeGreaterThan(0);
    expect(shared).toEqual(['file:///out.kvitto']);
    await act(async () => renderer.unmount());
  });
});
