import type { ArchiveEntrySource } from './types.js';

export interface ArchiveZipReader {
  open: (bytes: AsyncIterable<Uint8Array>) => Promise<ArchiveEntrySource>;
}

export interface ArchiveZipWriter {
  addEntry: (path: string, bytes: AsyncIterable<Uint8Array>) => Promise<void>;
  close: () => Promise<AsyncIterable<Uint8Array>>;
}

export class ZipAdapterNotImplementedError extends Error {
  constructor() {
    super('ZIP adapter is intentionally out of scope for Packet 8. Implement in Packet 14 native/web adapter layers.');
    this.name = 'ZipAdapterNotImplementedError';
  }
}
