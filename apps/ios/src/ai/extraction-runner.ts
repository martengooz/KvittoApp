import type { ID } from '@kvitto/shared/domain';

import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';
import type { IosDataRepository } from '../data/repository';
import { applyExtraction, applyExtractionFailure } from './apply-extraction';
import { ProviderCapabilityRegistry } from './capability-registry';
import { FileBackedRemoteExtractionAdapter } from './remote-extraction-adapter';
import {
  AnthropicExtractionProvider,
  OllamaExtractionProvider,
  OpenAiExtractionProvider,
} from './remote-providers';
import type { AdapterSettings, FileSourceReader } from './types';

/** How much of a staged image is read per chunk on its way to base64. */
const READ_CHUNK = 256 * 1024;

export interface ExtractionSettingsSnapshot {
  /** `none` means the user has turned extraction off. */
  mode: 'none' | 'local' | 'remote';
  settings: AdapterSettings | null;
}

export type ExtractionOutcomeKind = 'applied' | 'stale' | 'unsupported';

export interface CreateExtractionRunnerInput {
  repository: IosDataRepository;
  native: Pick<KvittoNativeFacade, 'getBlobMetadata' | 'readFileChunkBase64'>;
  /** Read fresh on every run, so turning AI off takes effect immediately. */
  getSettings: () => Promise<ExtractionSettingsSnapshot>;
  now?: () => number;
}

function decodeChunkToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Reads a blob off disk in chunks.
 *
 * The provider APIs take base64, so the image has to reach JavaScript
 * eventually - but it is read in pieces rather than in one call, so peak memory
 * is a chunk rather than the whole file.
 */
function createFileReader(native: CreateExtractionRunnerInput['native']): FileSourceReader {
  return {
    async readBytes(path: string): Promise<Uint8Array> {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      let total = 0;

      while (true) {
        const chunk = await native.readFileChunkBase64(path, offset, READ_CHUNK);
        if (chunk.length === 0) break;
        const bytes = decodeChunkToBytes(chunk);
        if (bytes.length === 0) break;
        chunks.push(bytes);
        offset += bytes.length;
        total += bytes.length;
      }

      const out = new Uint8Array(total);
      let cursor = 0;
      for (const chunk of chunks) {
        out.set(chunk, cursor);
        cursor += chunk.length;
      }
      return out;
    },
  };
}

/**
 * Builds the runner the extraction job calls.
 *
 * Settings are read per run rather than captured once, so turning AI off, or
 * switching provider, applies to the next job without rebuilding anything.
 *
 * A failure is recorded on the receipt before it is rethrown: the job runner
 * needs the throw to decide on a retry, and the user needs the reason to be
 * visible on the extraction screen rather than only in a log.
 */
export function createExtractionRunner(input: CreateExtractionRunnerInput) {
  const registry = new ProviderCapabilityRegistry();
  registry.register(new AnthropicExtractionProvider());
  registry.register(new OpenAiExtractionProvider());
  registry.register(new OllamaExtractionProvider());

  const now = input.now ?? (() => Date.now());

  const adapter = new FileBackedRemoteExtractionAdapter({
    providers: registry,
    fileReader: createFileReader(input.native),
    freshness: {
      // The receipt's `updatedAt` is its version. If it has moved on since the
      // job was claimed, a newer job exists and this result would overwrite it.
      async isCurrent(sourceId: string, revision: number): Promise<boolean> {
        const receipt = await input.repository.getReceipt(sourceId);
        if (!receipt) return false;
        return receipt.updatedAt <= revision;
      },
    },
  });

  return async function runExtraction(job: {
    receiptId: ID;
    sourceVersion: number;
    signal?: AbortSignal;
  }): Promise<ExtractionOutcomeKind> {
    const snapshot = await input.getSettings();
    if (snapshot.mode === 'none' || !snapshot.settings) return 'unsupported';

    /*
     * Checked here rather than left to the provider, because the adapter
     * flattens provider errors into "AI-leverantören kunde inte läsa kvittot
     * just nu." A missing key is a setting the user has to go and fix, and that
     * message would send them looking for the wrong problem. It also saves a
     * pointless round trip.
     */
    const needsKey = snapshot.settings.provider === 'anthropic' || snapshot.settings.provider === 'openai';
    if (needsKey && !snapshot.settings.apiKey?.trim()) {
      const message = `${snapshot.settings.provider} kräver en API-nyckel. Lägg till den i inställningarna.`;
      await applyExtractionFailure(
        input.repository,
        job.receiptId,
        snapshot.settings.provider,
        snapshot.settings.model,
        message,
        now(),
      );
      throw new Error(message);
    }

    const receipt = await input.repository.getReceipt(job.receiptId);
    if (!receipt) throw new Error(`missing-receipt:${job.receiptId}`);

    // Extraction reads the processed image, not the original: it is smaller,
    // already deskewed and enhanced, so it costs fewer tokens and reads better.
    const imageId = receipt.imageId ?? receipt.originalImageId;
    if (!imageId) throw new Error(`missing-image-for-extraction:${job.receiptId}`);

    const metadata = await input.native.getBlobMetadata(imageId);
    if (!metadata) throw new Error(`missing-image-metadata:${imageId}`);

    try {
      const outcome = await adapter.extract(
        {
          sourceId: job.receiptId,
          revision: job.sourceVersion,
          filePath: metadata.uri,
          mimeType: metadata.mimeType,
        },
        snapshot.settings,
        { signal: job.signal, allowCorrection: true },
      );

      if (outcome.status === 'stale-suppressed') return 'stale';

      await applyExtraction(input.repository, {
        receiptId: job.receiptId,
        extraction: outcome.attempt.extraction,
        response: outcome.attempt.response,
        warnings: outcome.attempt.warnings,
        now: now(),
      });
      return 'applied';
    } catch (error) {
      await applyExtractionFailure(
        input.repository,
        job.receiptId,
        snapshot.settings.provider,
        snapshot.settings.model,
        error instanceof Error ? error.message : String(error),
        now(),
      );
      throw error;
    }
  };
}
