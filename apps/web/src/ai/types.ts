/** Provider-facing contract for receipt extraction. */

import type { CorrectionContext, NormalizedExtraction } from '@kvitto/shared';
import type { AiSettings } from '../core/settings.js';

export interface ExtractionRequest {
  /** The processed receipt scan. */
  image: Blob;
  settings: AiSettings;
  /** Companion server base URL, required by the `server` provider. */
  serverUrl?: string;
  /** Bearer token for the companion server. */
  serverToken?: string;
  /**
   * Set to re-read a receipt whose first pass did not hold together, telling
   * the model what was wrong so it can look for the misreading.
   */
  correction?: CorrectionContext | null;
  /** Aborts the request when the user leaves the screen. */
  signal?: AbortSignal;
}

export interface ExtractionResponse {
  extraction: NormalizedExtraction;
  /** Raw parsed JSON from the model, kept for debugging a bad read. */
  raw: Record<string, unknown>;
  model: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  /** True when structured output was requested but the provider refused it. */
  structuredOutputFallback: boolean;
  /** True when this result came from a correcting second pass. */
  corrected: boolean;
}

export interface Provider {
  readonly id: string;
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
  /** Cheap round-trip that verifies credentials and model access. */
  test(request: Omit<ExtractionRequest, 'image'>): Promise<TestResult>;
}

export interface TestResult {
  ok: boolean;
  message: string;
  /** Models the provider reports, when it offers a listing endpoint. */
  models?: string[];
}

/** Raised for problems the user can act on; the message is shown verbatim. */
export class ExtractionError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number | null; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ExtractionError';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/** Encodes a blob as base64 without the data-URL prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  // Chunked to stay well under the argument-count limit of `String.fromCharCode`,
  // which a 1.5 MB image would otherwise blow past.
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Normalises a media type to one every vision API accepts. */
export function imageMediaType(blob: Blob): 'image/jpeg' | 'image/png' | 'image/webp' {
  switch (blob.type) {
    case 'image/png':
      return 'image/png';
    case 'image/webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}
