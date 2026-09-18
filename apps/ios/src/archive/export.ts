import {
  BLOB_METADATA_PATH,
  MANIFEST_PATH,
  SETTINGS_PATH,
  canonicalBlobPath,
  canonicalEntityPath,
  canonicalManifest,
  redactSettings,
  shouldExportEntityKind,
  type ArchiveEntityKind,
} from '@kvitto/archive';
import { ARCHIVE_ENTITY_KINDS } from '@kvitto/archive';
import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';

/** Rows staged per write, to bound how much JSON is held at once. */
const ROWS_PER_CHUNK = 200;

export type ExportNativePort = Pick<
  KvittoNativeFacade,
  'writeFileChunkBase64' | 'writeArchive' | 'makeScratchFileUri' | 'deleteScratchFile' | 'shareFile'
>;

export interface ArchiveExportBlob {
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  role: string;
  /** Where the blob already lives on disk; it is never read into JavaScript. */
  fileUri: string;
}

export interface ArchiveExportSource {
  listEntities(kind: ArchiveEntityKind): Promise<Record<string, unknown>[]>;
  listBlobs(): Promise<ArchiveExportBlob[]>;
  getSettings(): Promise<unknown>;
}

export interface ArchiveExportResult {
  destinationUri: string;
  entryCount: number;
  blobCount: number;
}

function encodeBase64(text: string): string {
  // Hermes provides `btoa`, but it only accepts Latin-1, so UTF-8 has to be
  // widened by hand first or every non-ASCII merchant name throws.
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/**
 * Writes a `.kvitto` archive.
 *
 * Generated content (the manifest, NDJSON streams, settings) is staged to
 * scratch files in chunks; blobs are handed to the writer as the files they
 * already are. Nothing reads a receipt image into JavaScript, which is what
 * keeps exporting a few thousand receipts from being a memory problem.
 *
 * Secrets never reach here: `shouldExportEntityKind` drops the `secrets` kind
 * and `redactSettings` strips everything section 14 lists as omitted. Both are
 * the shared implementations the web export uses, so the two cannot diverge.
 */
export async function exportArchive(
  native: ExportNativePort,
  source: ArchiveExportSource,
  destinationUri: string,
): Promise<ArchiveExportResult> {
  const staged: string[] = [];
  const entries: { path: string; sourceFileUri: string }[] = [];

  const stage = async (archivePath: string, write: (uri: string) => Promise<void>): Promise<void> => {
    const uri = native.makeScratchFileUri('archive-stage', 'bin');
    staged.push(uri);
    await write(uri);
    entries.push({ path: archivePath, sourceFileUri: uri });
  };

  try {
    const manifest = canonicalManifest();

    await stage(MANIFEST_PATH, async (uri) => {
      await native.writeFileChunkBase64(uri, encodeBase64(JSON.stringify(manifest)), false);
    });

    await stage(SETTINGS_PATH, async (uri) => {
      const redacted = redactSettings(await source.getSettings());
      await native.writeFileChunkBase64(uri, encodeBase64(JSON.stringify(redacted)), false);
    });

    for (const kind of ARCHIVE_ENTITY_KINDS) {
      await stage(canonicalEntityPath(kind), async (uri) => {
        // An excluded kind still gets its stream, empty: a missing entity
        // stream is a preflight error, so omitting it would produce an archive
        // this app would reject.
        const rows = shouldExportEntityKind(kind) ? await source.listEntities(kind) : [];
        if (rows.length === 0) {
          await native.writeFileChunkBase64(uri, encodeBase64(''), false);
          return;
        }
        for (let index = 0; index < rows.length; index += ROWS_PER_CHUNK) {
          const lines = rows
            .slice(index, index + ROWS_PER_CHUNK)
            .map((row) => JSON.stringify(row))
            .join('\n');
          await native.writeFileChunkBase64(
            uri,
            encodeBase64(index + ROWS_PER_CHUNK >= rows.length ? lines : `${lines}\n`),
            index > 0,
          );
        }
      });
    }

    const blobs = await source.listBlobs();

    await stage(BLOB_METADATA_PATH, async (uri) => {
      const lines = blobs
        .map((blob) =>
          JSON.stringify({
            sha256: blob.sha256,
            mimeType: blob.mimeType,
            width: blob.width,
            height: blob.height,
            sizeBytes: blob.sizeBytes,
            role: blob.role,
          }),
        )
        .join('\n');
      await native.writeFileChunkBase64(uri, encodeBase64(lines), false);
    });

    for (const blob of blobs) {
      entries.push({ path: canonicalBlobPath(blob.sha256), sourceFileUri: blob.fileUri });
    }

    const entryCount = await native.writeArchive(destinationUri, entries);
    return { destinationUri, entryCount, blobCount: blobs.length };
  } finally {
    // Only the staged copies are removed. A blob's `fileUri` is the live file
    // in the blob store, and deleting one of those would destroy user data.
    for (const uri of staged) {
      await native.deleteScratchFile(uri).catch(() => undefined);
    }
  }
}
