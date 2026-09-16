import { isBetterReading, normalizeExtraction, validateExtraction } from '@kvitto/shared';

import { ProviderCapabilityRegistry } from './capability-registry';
import {
  type AdapterSettings,
  type BackgroundAdapter,
  type ExtractionOutcome,
  type FileBackedReceiptSource,
  type FileSourceReader,
  type ProviderResponse,
  type RemoteExtractionProvider,
  type SourceFreshness,
  type VisibleExtractionError,
  toVisibleExtractionError,
} from './types';
import { VisibleExtractionError as VisibleError } from './types';

export interface RemoteExtractionAdapterOptions {
  providers: ProviderCapabilityRegistry;
  fileReader: FileSourceReader;
  freshness: SourceFreshness;
  backgroundAdapter?: BackgroundAdapter;
}

interface ProviderCallOptions {
  provider: RemoteExtractionProvider;
  source: FileBackedReceiptSource;
  settings: AdapterSettings;
  correction: { problems: string[]; previous: unknown } | null;
  forcePlainJson: boolean;
  signal?: AbortSignal;
}

const passThroughBackgroundAdapter: BackgroundAdapter = {
  async run<T>(_label: string, work: () => Promise<T>): Promise<T> {
    return work();
  },
};

function mediaTypeFor(source: FileBackedReceiptSource): 'image/jpeg' | 'image/png' | 'image/webp' {
  switch (source.mimeType) {
    case 'image/png':
      return 'image/png';
    case 'image/webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const maybeBuffer = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(format: 'base64'): string } } })
    .Buffer;
  if (maybeBuffer) return maybeBuffer.from(bytes).toString('base64');

  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }

  if (typeof btoa !== 'function') {
    throw new VisibleError('Kunde inte base64-koda bilddata på den här enheten.', {
      code: 'base64-unavailable',
      retryable: false,
    });
  }
  return btoa(binary);
}

function collectProblems(report: ReturnType<typeof validateExtraction>): string[] {
  return report.issues
    .filter((issue) => issue.severity !== 'info')
    .map((issue) => issue.message);
}

function collectWarnings(
  normalizedWarnings: string[],
  report: ReturnType<typeof validateExtraction>,
  fallbackUsed: boolean,
): string[] {
  const issues = report.issues
    .filter((issue) => issue.severity !== 'info')
    .map((issue) => issue.message);

  if (fallbackUsed) {
    issues.push('Leverantören stödde inte schema-läge; tolkningen kördes med prompt-baserad JSON.');
  }

  return [...normalizedWarnings, ...issues];
}

function toProviderError(error: unknown): VisibleExtractionError {
  const visible = toVisibleExtractionError(error, 'provider-failed');
  if (visible.code === 'provider-failed') {
    return new VisibleError('AI-leverantören kunde inte läsa kvittot just nu.', {
      code: 'provider-failed',
      retryable: true,
      cause: error,
    });
  }
  return visible;
}

export class FileBackedRemoteExtractionAdapter {
  private readonly providers: ProviderCapabilityRegistry;
  private readonly fileReader: FileSourceReader;
  private readonly freshness: SourceFreshness;
  private readonly backgroundAdapter: BackgroundAdapter;

  constructor(options: RemoteExtractionAdapterOptions) {
    this.providers = options.providers;
    this.fileReader = options.fileReader;
    this.freshness = options.freshness;
    this.backgroundAdapter = options.backgroundAdapter ?? passThroughBackgroundAdapter;
  }

  async extract(
    source: FileBackedReceiptSource,
    settings: AdapterSettings,
    options: { signal?: AbortSignal; allowCorrection?: boolean } = {},
  ): Promise<ExtractionOutcome> {
    const policy = await this.providers.policyForExtractionV1(settings.provider);
    if (!policy.allowed) {
      throw new VisibleError(policy.reason ?? 'Vald leverantör kan inte användas för kvittoutläsning.', {
        code: 'capability-policy-denied',
        retryable: false,
      });
    }

    const provider = this.providers.get(settings.provider);
    if (!provider) {
      throw new VisibleError('Ingen adapter registrerad för vald AI-leverantör.', {
        code: 'provider-missing',
        retryable: false,
      });
    }

    const initialCurrent = await this.freshness.isCurrent(source.sourceId, source.revision);
    if (!initialCurrent) {
      return { status: 'stale-suppressed', sourceId: source.sourceId, revision: source.revision };
    }

    const firstCall = await this.callProvider({
      provider,
      source,
      settings,
      correction: null,
      forcePlainJson: false,
      signal: options.signal,
    });

    const stillCurrent = await this.freshness.isCurrent(source.sourceId, source.revision);
    if (!stillCurrent) {
      return { status: 'stale-suppressed', sourceId: source.sourceId, revision: source.revision };
    }

    let best = firstCall;
    let fallbackUsed = firstCall.fallbackUsed;

    const firstReport = validateExtraction(firstCall.normalized);
    const correctionAllowed =
      options.allowCorrection !== false &&
      !firstReport.ok &&
      (await this.providers.supportsCorrection(settings.provider));

    if (correctionAllowed) {
      const corrected = await this.callProvider({
        provider,
        source,
        settings,
        correction: { problems: collectProblems(firstReport), previous: firstCall.response.raw },
        forcePlainJson: firstCall.fallbackUsed,
        signal: options.signal,
      }).catch((error) => {
        const visible = toProviderError(error);
        // Keep a usable first pass if correction fails for transient reasons.
        if (visible.retryable) return null;
        throw visible;
      });

      if (corrected) {
        const correctedReport = validateExtraction(corrected.normalized);
        if (isBetterReading(correctedReport, firstReport)) {
          best = corrected;
        }
        fallbackUsed = fallbackUsed || corrected.fallbackUsed;
      }
    }

    const finalCurrent = await this.freshness.isCurrent(source.sourceId, source.revision);
    if (!finalCurrent) {
      return { status: 'stale-suppressed', sourceId: source.sourceId, revision: source.revision };
    }

    const finalReport = validateExtraction(best.normalized);
    return {
      status: 'applied',
      attempt: {
        extraction: best.normalized,
        response: best.response,
        warnings: collectWarnings(best.normalized.warnings, finalReport, fallbackUsed),
        corrected: best.corrected,
      },
      fallbackUsed,
    };
  }

  private async callProvider(options: ProviderCallOptions): Promise<{
    response: ProviderResponse;
    normalized: ReturnType<typeof normalizeExtraction>;
    fallbackUsed: boolean;
    corrected: boolean;
  }> {
    const bytes = await this.backgroundAdapter.run('read-receipt-bytes', () =>
      this.fileReader.readBytes(options.source.filePath, options.signal),
    );

    const base64 = await this.backgroundAdapter.run('encode-receipt-base64', async () => bytesToBase64(bytes));

    const request = {
      model: options.settings.model,
      apiKey: options.settings.apiKey,
      baseUrl: options.settings.baseUrl,
      imageBase64: base64,
      mimeType: mediaTypeFor(options.source),
      maxOutputTokens: options.settings.maxOutputTokens,
      effort: options.settings.effort,
      structuredOutput: options.forcePlainJson ? false : options.settings.structuredOutput,
      extraInstructions: options.settings.extraInstructions,
      correction: options.correction,
      signal: options.signal,
    } as const;

    const invoke = async (structuredOutput: boolean): Promise<ProviderResponse> => {
      try {
        return await options.provider.extractV1({ ...request, structuredOutput });
      } catch (error) {
        throw toProviderError(error);
      }
    };

    let fallbackUsed = false;
    let response: ProviderResponse;

    try {
      response = await invoke(request.structuredOutput);
    } catch (error) {
      const visible = toProviderError(error);
      if (
        request.structuredOutput &&
        (visible.code === 'structured-output-unsupported' || visible.code === 'structured-output-rejected')
      ) {
        response = await invoke(false);
        fallbackUsed = true;
      } else {
        throw visible;
      }
    }

    if (response.structuredOutputFallback) fallbackUsed = true;

    const normalized = await this.backgroundAdapter.run('normalize-extraction', async () =>
      normalizeExtraction(response.raw),
    );

    return {
      response,
      normalized,
      fallbackUsed,
      corrected: Boolean(options.correction),
    };
  }
}
