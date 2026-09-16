import type { ArchiveEntrySink } from './archive-export-core';

const ZIP_SIGNATURES = {
  localFileHeader: 0x04034b50,
  dataDescriptor: 0x08074b50,
  centralDirectoryHeader: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
} as const;

const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_DEFLATE_METHOD = 8;

const CRC32_TABLE = makeCrc32Table();

export interface ArchiveZipSink extends ArchiveEntrySink {
  close: () => Promise<Blob>;
}

export interface ArchiveExportCapability {
  supported: boolean;
  reason: string | null;
  mode: 'injected-sink' | 'compression-stream' | null;
}

export function supportsZipCompressionStream(): boolean {
  if (typeof CompressionStream === 'undefined') return false;
  try {
    new CompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

export function getArchiveExportCapability(options: {
  sinkFactory?: (() => ArchiveZipSink) | null;
  codecAvailable?: boolean;
} = {}): ArchiveExportCapability {
  if (options.sinkFactory) {
    return {
      supported: true,
      reason: null,
      mode: 'injected-sink',
    };
  }

  const codecAvailable = options.codecAvailable ?? supportsZipCompressionStream();
  if (codecAvailable) {
    return {
      supported: true,
      reason: null,
      mode: 'compression-stream',
    };
  }

  return {
    supported: false,
    reason:
      'Den här webbläsaren saknar ZIP-komprimering (CompressionStream deflate-raw). ' +
      'Export kräver en ZIP-adapter och är därför avstängd.',
    mode: null,
  };
}

interface CentralDirectoryEntry {
  path: string;
  name: Uint8Array;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}

function zipDateParts(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function bytesOfString(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function cloneChunk(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunk.byteLength);
  out.set(chunk);
  return out;
}

function u16(target: DataView, offset: number, value: number): void {
  target.setUint16(offset, value, true);
}

function u32(target: DataView, offset: number, value: number): void {
  target.setUint32(offset, value >>> 0, true);
}

function createLocalFileHeader(path: Uint8Array, dosTime: number, dosDate: number): Uint8Array {
  const out = new Uint8Array(30 + path.byteLength);
  const view = new DataView(out.buffer);

  u32(view, 0, ZIP_SIGNATURES.localFileHeader);
  u16(view, 4, 20);
  u16(view, 6, ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG);
  u16(view, 8, ZIP_DEFLATE_METHOD);
  u16(view, 10, dosTime);
  u16(view, 12, dosDate);
  u32(view, 14, 0);
  u32(view, 18, 0);
  u32(view, 22, 0);
  u16(view, 26, path.byteLength);
  u16(view, 28, 0);
  out.set(path, 30);

  return out;
}

function createDataDescriptor(crc32: number, compressedSize: number, uncompressedSize: number): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  u32(view, 0, ZIP_SIGNATURES.dataDescriptor);
  u32(view, 4, crc32);
  u32(view, 8, compressedSize);
  u32(view, 12, uncompressedSize);
  return out;
}

function createCentralDirectoryHeader(entry: CentralDirectoryEntry): Uint8Array {
  const out = new Uint8Array(46 + entry.name.byteLength);
  const view = new DataView(out.buffer);

  u32(view, 0, ZIP_SIGNATURES.centralDirectoryHeader);
  u16(view, 4, 20);
  u16(view, 6, 20);
  u16(view, 8, ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG);
  u16(view, 10, ZIP_DEFLATE_METHOD);
  u16(view, 12, entry.dosTime);
  u16(view, 14, entry.dosDate);
  u32(view, 16, entry.crc32);
  u32(view, 20, entry.compressedSize);
  u32(view, 24, entry.uncompressedSize);
  u16(view, 28, entry.name.byteLength);
  u16(view, 30, 0);
  u16(view, 32, 0);
  u16(view, 34, 0);
  u16(view, 36, 0);
  u32(view, 38, 0);
  u32(view, 42, entry.localHeaderOffset);
  out.set(entry.name, 46);

  return out;
}

function createEndOfCentralDirectory(totalEntries: number, centralDirectorySize: number, centralDirectoryOffset: number): Uint8Array {
  const out = new Uint8Array(22);
  const view = new DataView(out.buffer);
  u32(view, 0, ZIP_SIGNATURES.endOfCentralDirectory);
  u16(view, 4, 0);
  u16(view, 6, 0);
  u16(view, 8, totalEntries);
  u16(view, 10, totalEntries);
  u32(view, 12, centralDirectorySize);
  u32(view, 16, centralDirectoryOffset);
  u16(view, 20, 0);
  return out;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32Update(seed: number, bytes: Uint8Array): number {
  let crc = seed ^ 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createCompressionStreamZipSink(now = new Date()): ArchiveZipSink {
  const chunks: BlobPart[] = [];
  const entries: CentralDirectoryEntry[] = [];
  let archiveOffset = 0;

  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    chunks.push(cloneChunk(chunk));
    archiveOffset += chunk.byteLength;
  };

  return {
    addEntry: async (path, bytes) => {
      const name = bytesOfString(path);
      if (name.byteLength > 0xffff) {
        throw new Error(`Archive entry path too long: ${path}`);
      }

      const { dosTime, dosDate } = zipDateParts(now);
      const localHeaderOffset = archiveOffset;
      await writeChunk(createLocalFileHeader(name, dosTime, dosDate));

      const compressor = new CompressionStream('deflate-raw');
      const writer = compressor.writable.getWriter();
      const reader = compressor.readable.getReader();

      let crc32 = 0;
      let compressedSize = 0;
      let uncompressedSize = 0;

      const pumpInput = (async () => {
        try {
          for await (const chunk of bytes) {
            crc32 = crc32Update(crc32, chunk);
            uncompressedSize += chunk.byteLength;
            await writer.write(cloneChunk(chunk));
          }
          await writer.close();
        } catch (error) {
          await writer.abort(error);
          throw error;
        }
      })();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        compressedSize += value.byteLength;
        await writeChunk(value);
      }

      await pumpInput;
      await writeChunk(createDataDescriptor(crc32, compressedSize, uncompressedSize));

      entries.push({
        path,
        name,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dosTime,
        dosDate,
      });
    },

    close: async () => {
      const centralDirectoryOffset = archiveOffset;
      for (const entry of entries) {
        await writeChunk(createCentralDirectoryHeader(entry));
      }
      const centralDirectorySize = archiveOffset - centralDirectoryOffset;
      await writeChunk(createEndOfCentralDirectory(entries.length, centralDirectorySize, centralDirectoryOffset));

      return new Blob(chunks, {
        type: 'application/vnd.kvitto.archive+zip',
      });
    },
  };
}
