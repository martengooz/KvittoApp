/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { createNativeArchiveEntrySource, type ArchiveNativePort } from '../src/archive/native-entry-source';
import { ArchivePreflightScreen } from '../src/archive/preflight-view';
import { ArchiveResultScreen } from '../src/archive/result-view';
import type { PreflightReport } from '@kvitto/archive';
import { alwaysConfirm } from '../src/ui/confirm';

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function textOf(renderer: ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings.join(' | ');
}

function control(renderer: ReactTestRenderer, label: string, handler: string): ReactTestInstance {
  const matches = renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.[handler] === 'function',
  );
  if (matches.length === 0) throw new Error(`No control “${label}”. Rendered: ${textOf(renderer)}`);
  return matches[matches.length - 1]!;
}

/** An in-memory stand-in for the native archive functions. */
function fakeNative(entries: Record<string, string>, overrides: Partial<ArchiveNativePort> = {}) {
  const scratch = new Map<string, string>();
  const deleted: string[] = [];
  let scratchCount = 0;

  const port: ArchiveNativePort = {
    readArchiveIndex: async () =>
      Object.entries(entries).map(([path, content]) => ({
        path,
        uncompressedSize: content.length,
        compressedSize: content.length,
        method: 8,
      })),
    extractArchiveEntry: async (_uri, path, destination) => {
      const content = entries[path];
      if (content === undefined) throw new Error(`no such entry: ${path}`);
      scratch.set(destination, content);
      return content.length;
    },
    readFileChunkBase64: async (uri, offset, length) => {
      const content = scratch.get(uri) ?? '';
      const slice = content.slice(offset, offset + length);
      return slice.length === 0 ? '' : globalThis.btoa(slice);
    },
    makeScratchFileUri: () => `file:///scratch/${(scratchCount += 1)}.bin`,
    deleteScratchFile: async (uri) => {
      deleted.push(uri);
      scratch.delete(uri);
      return true;
    },
    ...overrides,
  };

  return { port, deleted, scratchCount: () => scratchCount };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of iterable) {
    out += String.fromCharCode(...chunk);
  }
  return out;
}

describe('native archive entry source', () => {
  test('lists entries and streams their bytes back', async () => {
    const { port } = fakeNative({ 'manifest.json': '{"version":1}' });
    const source = createNativeArchiveEntrySource(port, 'file:///a.kvitto');

    const seen: string[] = [];
    for await (const entry of source.entries()) {
      expect(entry.path).toBe('manifest.json');
      seen.push(await collect(entry.open()));
    }

    expect(seen).toEqual(['{"version":1}']);
  });

  test('a large entry arrives in several chunks, not one buffer', async () => {
    const big = 'x'.repeat(600 * 1024);
    const { port } = fakeNative({ 'blobs/big': big });
    const source = createNativeArchiveEntrySource(port, 'file:///a.kvitto');

    let chunks = 0;
    for await (const entry of source.entries()) {
      for await (const _chunk of entry.open()) chunks += 1;
    }

    // 600KB at 256KB per read.
    expect(chunks).toBe(3);
  });

  test('the scratch copy is removed after the entry is read', async () => {
    const { port, deleted } = fakeNative({ 'manifest.json': '{}' });
    const source = createNativeArchiveEntrySource(port, 'file:///a.kvitto');

    for await (const entry of source.entries()) {
      await collect(entry.open());
    }

    expect(deleted).toHaveLength(1);
  });

  test('the scratch copy is removed even when reading stops early', async () => {
    const { port, deleted } = fakeNative({ 'blobs/big': 'y'.repeat(600 * 1024) });
    const source = createNativeArchiveEntrySource(port, 'file:///a.kvitto');

    for await (const entry of source.entries()) {
      for await (const _chunk of entry.open()) {
        // Abandoning the stream is what a rejected import does; the unpacked
        // copy must not be left in the caches directory.
        break;
      }
    }

    expect(deleted).toHaveLength(1);
  });

  test('the scratch copy is removed when extraction fails', async () => {
    const { port, deleted } = fakeNative(
      { 'blobs/bad': 'z' },
      { extractArchiveEntry: async () => { throw new Error('checksum mismatch'); } },
    );
    const source = createNativeArchiveEntrySource(port, 'file:///a.kvitto');

    for await (const entry of source.entries()) {
      await expect(collect(entry.open())).rejects.toThrow('checksum mismatch');
    }

    expect(deleted).toHaveLength(1);
  });
});

describe('archive preflight screen', () => {
  async function render(port: ArchiveNativePort, onReport?: (report: PreflightReport) => void) {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ArchivePreflightScreen native={port} onReport={onReport} />);
    });
    await flush();
    return renderer!;
  }

  async function press(renderer: ReactTestRenderer, label: string) {
    await act(async () => {
      (control(renderer, label, 'onPress').props as { onPress: () => void }).onPress();
    });
    await flush();
    await flush();
  }

  async function type(renderer: ReactTestRenderer, label: string, value: string) {
    await act(async () => {
      (control(renderer, label, 'onChangeText').props as { onChangeText: (v: string) => void }).onChangeText(value);
    });
  }

  test('refuses to run without a file rather than reporting nothing', async () => {
    const { port } = fakeNative({});
    const renderer = await render(port);

    await press(renderer, 'Check archive');

    expect(textOf(renderer)).toContain('Choose an archive file first.');
    await act(async () => renderer.unmount());
  });

  test('an archive missing its manifest is rejected, and says why', async () => {
    const { port } = fakeNative({ 'entities/receipts.ndjson': '' });
    const renderer = await render(port);

    await type(renderer, 'Archive file URI', 'file:///a.kvitto');
    await press(renderer, 'Check archive');

    const text = textOf(renderer);
    expect(text).toContain('Archive was rejected');
    expect(text).toContain('missing_manifest');
    await act(async () => renderer.unmount());
  });

  test('a file that is not a ZIP is reported in words, not as an empty report', async () => {
    const { port } = fakeNative(
      {},
      { readArchiveIndex: async () => { throw new Error('notAZipFile'); } },
    );
    const renderer = await render(port);

    await type(renderer, 'Archive file URI', 'file:///not-a.zip');
    await press(renderer, 'Check archive');

    expect(textOf(renderer)).toContain('notAZipFile');
    expect(textOf(renderer)).not.toContain('Archive can be imported');
    await act(async () => renderer.unmount());
  });

  test('the report is handed to the caller so the route can move on', async () => {
    const { port } = fakeNative({ 'entities/receipts.ndjson': '' });
    const reports: PreflightReport[] = [];
    const renderer = await render(port, (report) => reports.push(report));

    await type(renderer, 'Archive file URI', 'file:///a.kvitto');
    await press(renderer, 'Check archive');

    expect(reports).toHaveLength(1);
    expect(reports[0]!.ok).toBe(false);
    await act(async () => renderer.unmount());
  });
});

describe('archive result screen', () => {
  async function render(
    report: PreflightReport | null,
    onApply?: () => Promise<import('../src/archive/apply').ArchiveApplyResult>,
  ) {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ArchiveResultScreen report={report} onApply={onApply} confirm={alwaysConfirm} />);
    });
    await flush();
    return renderer!;
  }

  test('opened without a report, it says so instead of rendering blank', async () => {
    const renderer = await render(null);
    expect(textOf(renderer)).toContain('No archive checked');
    await act(async () => renderer.unmount());
  });

  test('a rejected archive leads with the first blocking problem', async () => {
    const renderer = await render({
      ok: false,
      manifest: null,
      issues: [{ severity: 'error', code: 'missing_manifest', message: 'manifest.json is missing.' }],
      entryCount: 2,
      totalUncompressedBytes: 10,
      entityCounts: {},
      blobCount: 0,
    });

    const text = textOf(renderer);
    expect(text).toContain('Archive cannot be imported');
    expect(text).toContain('manifest.json is missing.');
    await act(async () => renderer.unmount());
  });

  test('an importable archive with no apply available says so', async () => {
    const renderer = await render({
      ok: true,
      manifest: { version: 1 } as PreflightReport['manifest'],
      issues: [],
      entryCount: 5,
      totalUncompressedBytes: 2048,
      entityCounts: {},
      blobCount: 1,
    });

    const text = textOf(renderer);
    expect(text).toContain('Archive is importable');
    // No apply function means no button, and a sentence instead.
    expect(text).toContain('not available on this device');
    await act(async () => renderer.unmount());
  });

  test('a rejected archive is never offered an import button', async () => {
    const renderer = await render(
      {
        ok: false,
        manifest: null,
        issues: [{ severity: 'error', code: 'missing_manifest', message: 'manifest.json is missing.' }],
        entryCount: 1,
        totalUncompressedBytes: 1,
        entityCounts: {},
        blobCount: 0,
      },
      async () => ({ created: 0, updated: 0, unchanged: 0, blobsStored: 0, blobsAlreadyPresent: 0 }),
    );

    expect(
      renderer.root.findAll((node) => node.props?.accessibilityLabel === 'Import archive'),
    ).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  test('importing reports what it changed', async () => {
    const renderer = await render(
      {
        ok: true,
        manifest: { version: 1 } as PreflightReport['manifest'],
        issues: [],
        entryCount: 5,
        totalUncompressedBytes: 2048,
        entityCounts: {},
        blobCount: 1,
      },
      async () => ({ created: 3, updated: 1, unchanged: 2, blobsStored: 1, blobsAlreadyPresent: 0 }),
    );

    const button = renderer.root.findAll(
      (node) => node.props?.accessibilityLabel === 'Import archive' && typeof node.props?.onPress === 'function',
    );
    await act(async () => {
      (button[button.length - 1]!.props as { onPress: () => void }).onPress();
    });
    await flush();
    await flush();

    const text = textOf(renderer);
    expect(text).toContain('Created: 3');
    expect(text).toContain('Already up to date: 2');
    await act(async () => renderer.unmount());
  });
});
