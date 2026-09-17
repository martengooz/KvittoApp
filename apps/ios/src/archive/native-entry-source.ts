import type { ArchiveEntry, ArchiveEntrySource } from '@kvitto/archive';
import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';

/** Bytes pulled back from a scratch file per read. */
const CHUNK_BYTES = 256 * 1024;

/** The subset of the native facade this needs, so tests can supply a fake. */
export type ArchiveNativePort = Pick<
  KvittoNativeFacade,
  'readArchiveIndex' | 'extractArchiveEntry' | 'readFileChunkBase64' | 'makeScratchFileUri' | 'deleteScratchFile'
>;

function decodeBase64(value: string): Uint8Array {
  // Hermes has `atob`, but not `Buffer`.
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Presents a `.kvitto` file on disk as the entry source `packages/archive`
 * expects, so the preflight rules written for the web run unchanged here.
 *
 * Entries are extracted to scratch files one at a time and streamed back in
 * chunks. A receipt image can be several megabytes and an archive can hold
 * thousands, so nothing materialises a whole archive - or a whole entry - in
 * JavaScript memory.
 */
export function createNativeArchiveEntrySource(
  native: ArchiveNativePort,
  archiveFileUri: string,
): ArchiveEntrySource {
  return {
    entries: async function* (): AsyncIterable<ArchiveEntry> {
      const index = await native.readArchiveIndex(archiveFileUri);

      for (const item of index) {
        yield {
          path: item.path,
          uncompressedSize: item.uncompressedSize,
          open: () =>
            (async function* (): AsyncIterable<Uint8Array> {
              const scratchUri = native.makeScratchFileUri('archive-entry', 'bin');
              try {
                await native.extractArchiveEntry(archiveFileUri, item.path, scratchUri);

                let offset = 0;
                while (true) {
                  const chunk = await native.readFileChunkBase64(scratchUri, offset, CHUNK_BYTES);
                  if (chunk.length === 0) break;
                  const bytes = decodeBase64(chunk);
                  if (bytes.length === 0) break;
                  offset += bytes.length;
                  yield bytes;
                }
              } finally {
                // The scratch copy goes even when the consumer stops early or
                // throws; otherwise a rejected import leaves the whole archive
                // unpacked in the caches directory.
                await native.deleteScratchFile(scratchUri).catch(() => undefined);
              }
            })(),
        };
      }
    },
  };
}
