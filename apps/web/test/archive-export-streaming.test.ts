import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArchiveEntityKind } from '@kvitto/archive';

import { redactSettingsForArchive, writeArchiveExport, type ArchiveEntrySink } from '../src/migration/archive-export-core.ts';

const decoder = new TextDecoder();

async function readText(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of bytes) {
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode(new Uint8Array(0));
  return out;
}

void test('redactSettingsForArchive clears API keys', () => {
  const redacted = redactSettingsForArchive({
    ai: {
      provider: 'openai',
      model: 'gpt-5',
      baseUrl: 'https://api.openai.com',
      apiKey: 'secret-ai',
      maxOutputTokens: 1000,
      effort: 'auto',
      structuredOutput: true,
      autoParse: true,
      extraInstructions: '',
    },
    image: {
      detectEdges: true,
      autoCapture: true,
      enhance: 'grayscale',
      maxDimension: 1200,
      quality: 0.9,
      keepOriginal: false,
    },
    company: {
      apiKey: 'secret-company',
      baseUrl: 'https://example.test',
      autoLookup: true,
      nameSearch: true,
      searchBudget: 5,
    },
    sync: {
      serverUrl: 'https://sync.example.test',
      autoSync: true,
      syncImages: true,
    },
    ui: {
      theme: 'system',
      showAuxiliaryLines: false,
    },
  });

  const ai = redacted.ai as { apiKey?: string };
  const company = redacted.company as { apiKey?: string };
  assert.equal(ai.apiKey, '');
  assert.equal(company.apiKey, '');
});

void test('writeArchiveExport writes streams, includes tombstones, and does not require blob arrayBuffer', async () => {
  let streamOpened = 0;

  const fakeBlob = {
    stream(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          streamOpened += 1;
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      });
    },
    arrayBuffer(): Promise<ArrayBuffer> {
      throw new Error('arrayBuffer must not be used for blob export streaming');
    },
  };

  const written = new Map<string, string>();
  const sink: ArchiveEntrySink = {
    addEntry: async (path, bytes) => {
      if (path.startsWith('blobs/')) {
        let size = 0;
        for await (const chunk of bytes) {
          size += chunk.byteLength;
        }
        written.set(path, `BINARY:${size}`);
        return;
      }
      written.set(path, await readText(bytes));
    },
  };

  const source = {
    getSettings: () => ({
      ai: {
        provider: 'none' as const,
        model: 'x',
        baseUrl: '',
        apiKey: 'hidden',
        maxOutputTokens: 1200,
        effort: 'auto' as const,
        structuredOutput: true,
        autoParse: true,
        extraInstructions: '',
      },
      image: {
        detectEdges: true,
        autoCapture: true,
        enhance: 'grayscale' as const,
        maxDimension: 1200,
        quality: 0.9,
        keepOriginal: false,
      },
      company: {
        apiKey: 'hidden',
        baseUrl: 'https://example.test',
        autoLookup: true,
        nameSearch: true,
        searchBudget: 5,
      },
      sync: {
        serverUrl: 'https://sync.example.test',
        autoSync: true,
        syncImages: true,
      },
      ui: {
        theme: 'system' as const,
        showAuxiliaryLines: false,
      },
    }),
    listEntities: async (kind: ArchiveEntityKind) => {
      if (kind === 'receipts') {
        return [{ id: 'r1', updatedAt: 1, deletedAt: 1, rev: 0, dirty: 1 }];
      }
      return [];
    },
    listBlobs: async () => [
      {
        id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        mimeType: 'image/jpeg',
        byteSize: 6,
        width: 200,
        height: 100,
        role: 'thumb' as const,
        data: fakeBlob,
      },
    ],
  };

  await writeArchiveExport(sink, source);

  const settingsText = written.get('settings.json');
  assert.ok(settingsText);
  assert.equal(settingsText?.includes('hidden'), false);

  assert.equal(written.get('entities/receipts.ndjson')?.includes('"deletedAt":1'), true);
  assert.equal(written.get('entities/secrets.ndjson'), '');
  assert.equal(written.get('blobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), 'BINARY:6');

  const metadata = written.get('blob-metadata.ndjson') ?? '';
  assert.equal(metadata.includes('"role":"thumbnail"'), true);
  assert.equal(streamOpened, 1);
});
