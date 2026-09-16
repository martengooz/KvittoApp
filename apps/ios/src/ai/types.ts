import type { CorrectionContext, NormalizedExtraction } from '@kvitto/shared';

export type AiProviderId =
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'ollama'
  | 'server'
  | 'manual'
  | 'foundation-models';

export type ProviderKind = 'cloud' | 'self-hosted' | 'proxy' | 'manual' | 'on-device';

export interface ProviderCapabilities {
  providerId: AiProviderId;
  label: string;
  kind: ProviderKind;
  available: boolean;
  supportsExtractionV1: boolean;
  supportsStructuredOutput: boolean;
  supportsCorrection: boolean;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
}

export interface CapabilityPolicy {
  allowed: boolean;
  reason: string | null;
}

export interface FileBackedReceiptSource {
  sourceId: string;
  revision: number;
  filePath: string;
  mimeType?: string;
}

export interface AdapterSettings {
  provider: AiProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens: number;
  effort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  structuredOutput: boolean;
  extraInstructions: string;
}

export interface ProviderRequest {
  model: string;
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens: number;
  effort: AdapterSettings['effort'];
  structuredOutput: boolean;
  extraInstructions: string;
  correction?: CorrectionContext | null;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  raw: Record<string, unknown>;
  model: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  structuredOutputFallback?: boolean;
}

export interface RemoteExtractionProvider {
  readonly id: AiProviderId;
  getAvailability(): Promise<boolean>;
  getCapabilities(): Promise<ProviderCapabilities>;
  extractV1(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ExtractionAttempt {
  extraction: NormalizedExtraction;
  response: ProviderResponse;
  warnings: string[];
  corrected: boolean;
}

export type ExtractionOutcome =
  | {
      status: 'applied';
      attempt: ExtractionAttempt;
      fallbackUsed: boolean;
    }
  | {
      status: 'stale-suppressed';
      sourceId: string;
      revision: number;
    };

export interface BackgroundAdapter {
  run<T>(label: string, work: () => Promise<T>): Promise<T>;
}

export interface FileSourceReader {
  readBytes(path: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface SourceFreshness {
  isCurrent(sourceId: string, revision: number): boolean | Promise<boolean>;
}

export class VisibleExtractionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code: string; retryable?: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'VisibleExtractionError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export function toVisibleExtractionError(error: unknown, fallbackCode = 'unexpected'): VisibleExtractionError {
  if (error instanceof VisibleExtractionError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new VisibleExtractionError('Extraktionen avbröts.', { code: 'aborted', retryable: true, cause: error });
  }
  if (error instanceof Error) {
    return new VisibleExtractionError(error.message, { code: fallbackCode, cause: error });
  }
  return new VisibleExtractionError(String(error), { code: fallbackCode, retryable: false, cause: error });
}
