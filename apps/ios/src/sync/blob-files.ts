import type { ImageRole, KvittoNativeFacade } from '../../modules/kvitto-native/src';
import type { BlobFilePort } from './transport/client';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Hermes has no Buffer and no reliable btoa, so bytes are encoded here. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index]!;
    const byte1 = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const byte2 = index + 2 < bytes.length ? bytes[index + 2]! : 0;

    out += BASE64_ALPHABET[byte0 >> 2];
    out += BASE64_ALPHABET[((byte0 & 0x03) << 4) | (byte1 >> 4)];
    out += index + 1 < bytes.length ? BASE64_ALPHABET[((byte1 & 0x0f) << 2) | (byte2 >> 6)] : '=';
    out += index + 2 < bytes.length ? BASE64_ALPHABET[byte2 & 0x3f] : '=';
  }
  return out;
}

/**
 * Tells the download writer which role a freshly pulled blob plays, so the
 * stored metadata matches what the receipt references. The image planner fills
 * this in while it decides what to fetch.
 */
export interface BlobRoleRegistry {
  roleOf(id: string): ImageRole;
  remember(id: string, role: ImageRole): void;
}

export function createBlobRoleRegistry(): BlobRoleRegistry {
  const roles = new Map<string, ImageRole>();
  return {
    roleOf: (id) => roles.get(id) ?? 'processed',
    remember: (id, role) => {
      roles.set(id, role);
    },
  };
}

export interface CreateBlobFilePortInput {
  native: KvittoNativeFacade;
  roles: BlobRoleRegistry;
  /** Reads a local blob file for upload. Defaults to fetching the file URI. */
  readFile?: (path: string) => Promise<Uint8Array>;
}

async function fetchLocalFile(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not read blob file for sync upload (${path}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function createBlobFilePort(input: CreateBlobFilePortInput): BlobFilePort {
  const readFile = input.readFile ?? fetchLocalFile;

  return {
    async getUploadDescriptor(id) {
      const record = await input.native.getBlobMetadata(id);
      if (!record) {
        throw new Error(`Blob metadata is missing for upload id ${id}.`);
      }
      return {
        id,
        mimeType: record.mimeType,
        filePath: record.uri,
      };
    },

    readFile,

    async writeDownloadedBlob({ id, mimeType, bytes }) {
      // The native side verifies the bytes hash to `id` before storing them, so
      // a corrupted or substituted download fails here rather than becoming a
      // permanently wrong receipt image.
      await input.native.storeDownloadedBlob({
        base64: encodeBase64(bytes),
        mimeType,
        sha256Id: id,
        role: input.roles.roleOf(id),
      });
    },
  };
}
