import { describeError } from '@kvitto/shared';

import { writeArchiveExportFromDatabase } from './archive-export.js';
import {
  createCompressionStreamZipSink,
  getArchiveExportCapability,
  type ArchiveExportCapability,
  type ArchiveZipSink,
} from './archive-export-browser-core.js';

export { getArchiveExportCapability, type ArchiveExportCapability } from './archive-export-browser-core.js';

export const ARCHIVE_EXPORT_WARNING =
  'Arkivet innehaller kvittobilder och ekonomisk information. V1-arkiv ar inte losenordskrypterade.';

export interface ArchiveExportDownloadResult {
  ok: boolean;
  message: string;
  filename?: string;
  blobCount?: number;
}

export interface ExportArchiveToDownloadOptions {
  sinkFactory?: () => ArchiveZipSink;
  onDownload?: (blob: Blob, filename: string) => void;
  now?: Date;
}

function defaultFilename(now = new Date()): string {
  return `kvitto-export-${now.toISOString().slice(0, 10)}.kvitto`;
}

function defaultDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function resolveCapability(options: ExportArchiveToDownloadOptions): ArchiveExportCapability {
  return getArchiveExportCapability({ sinkFactory: options.sinkFactory ?? null });
}

export async function exportArchiveToDownload(options: ExportArchiveToDownloadOptions = {}): Promise<ArchiveExportDownloadResult> {
  const capability = resolveCapability(options);
  if (!capability.supported) {
    return {
      ok: false,
      message: capability.reason ?? 'Export ar inte tillganglig i den har webblasaren.',
    };
  }

  const sink = options.sinkFactory
    ? options.sinkFactory()
    : createCompressionStreamZipSink(options.now);

  try {
    const { blobCount } = await writeArchiveExportFromDatabase(sink);
    const blob = await sink.close();
    const filename = defaultFilename(options.now);
    (options.onDownload ?? defaultDownload)(blob, filename);

    return {
      ok: true,
      message: `Arkivet exporterades (${blobCount} bilder).`,
      filename,
      blobCount,
    };
  } catch (error) {
    return {
      ok: false,
      message: describeError(error),
    };
  }
}
