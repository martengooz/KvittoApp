import { describe, expect, test } from '@jest/globals';

import { FileBackedRemoteExtractionAdapter } from '../src/ai/remote-extraction-adapter';
import { ProviderCapabilityRegistry } from '../src/ai/capability-registry';
import type {
  BackgroundAdapter,
  FileSourceReader,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  RemoteExtractionProvider,
  SourceFreshness,
} from '../src/ai/types';
import { VisibleExtractionError } from '../src/ai/types';

class MemoryReader implements FileSourceReader {
  async readBytes(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3, 4]);
  }
}

class AlwaysFresh implements SourceFreshness {
  async isCurrent(): Promise<boolean> {
    return true;
  }
}

const directBackground: BackgroundAdapter = {
  async run<T>(_label: string, work: () => Promise<T>): Promise<T> {
    return work();
  },
};

class MockProvider implements RemoteExtractionProvider {
  readonly id = 'openai' as const;
  public readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly implementation: (request: ProviderRequest) => Promise<ProviderResponse>,
  ) {}

  async getAvailability(): Promise<boolean> {
    return true;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      providerId: this.id,
      label: 'OpenAI',
      kind: 'cloud',
      available: true,
      supportsExtractionV1: true,
      supportsStructuredOutput: true,
      supportsCorrection: true,
      requiresApiKey: true,
      requiresBaseUrl: false,
    };
  }

  async extractV1(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    return this.implementation(request);
  }
}

function buildRegistry(provider: RemoteExtractionProvider): ProviderCapabilityRegistry {
  const registry = new ProviderCapabilityRegistry();
  registry.register(provider);
  return registry;
}

const source = {
  sourceId: 'receipt-1',
  revision: 3,
  filePath: '/tmp/receipt-1.jpg',
  mimeType: 'image/jpeg' as const,
};

const settings = {
  provider: 'openai' as const,
  model: 'gpt-test',
  apiKey: 'key',
  baseUrl: 'https://api.example.com/v1',
  maxOutputTokens: 4000,
  effort: 'auto' as const,
  structuredOutput: true,
  extraInstructions: '',
};

describe('ai extraction adapter', () => {
  test('falls back from structured output and keeps corrected pass when better', async () => {
    const provider = new MockProvider(async (request) => {
      if (request.structuredOutput) {
        throw new VisibleExtractionError('schema rejected', {
          code: 'structured-output-rejected',
          retryable: false,
        });
      }

      if (!request.correction) {
        return {
          raw: {
            merchant: { name: 'ICA Maxi' },
            purchasedAt: '2026-01-01 12:00',
            currency: 'SEK',
            total: '100,00',
            subtotal: null,
            discountTotal: null,
            roundingAmount: null,
            depositTotal: null,
            vatLines: [],
            paymentMethod: null,
            cardLast4: null,
            receiptNumber: null,
            terminalId: null,
            cashier: null,
            items: [
              { name: 'Mjolk', quantity: '1', unit: 'st', unitPrice: '90,00', totalPrice: '90,00', rawName: null, discount: null, vatRate: null, ean: null, deposit: null },
            ],
            confidence: 0.8,
          },
          model: 'gpt-test',
          provider: 'openai',
          inputTokens: 10,
          outputTokens: 20,
          durationMs: 50,
        };
      }

      return {
        raw: {
          merchant: { name: 'ICA Maxi' },
          purchasedAt: '2026-01-01 12:00',
          currency: 'SEK',
          total: '100,00',
          subtotal: null,
          discountTotal: null,
          roundingAmount: null,
          depositTotal: null,
          vatLines: [],
          paymentMethod: null,
          cardLast4: null,
          receiptNumber: null,
          terminalId: null,
          cashier: null,
          items: [
            { name: 'Mjolk', quantity: '1', unit: 'st', unitPrice: '100,00', totalPrice: '100,00', rawName: null, discount: null, vatRate: null, ean: null, deposit: null },
          ],
          confidence: 0.9,
        },
        model: 'gpt-test',
        provider: 'openai',
        inputTokens: 12,
        outputTokens: 22,
        durationMs: 45,
      };
    });

    const adapter = new FileBackedRemoteExtractionAdapter({
      providers: buildRegistry(provider),
      fileReader: new MemoryReader(),
      freshness: new AlwaysFresh(),
      backgroundAdapter: directBackground,
    });

    const outcome = await adapter.extract(source, settings);
    expect(outcome.status).toBe('applied');
    if (outcome.status !== 'applied') return;

    expect(outcome.fallbackUsed).toBe(true);
    expect(outcome.attempt.corrected).toBe(true);
    expect(outcome.attempt.extraction.items[0]?.totalPrice).toBe(100);
    expect(outcome.attempt.warnings.some((warning) => warning.includes('schema-l'))).toBe(true);
    expect(provider.calls).toHaveLength(3);
  });

  test('surfaces retryable provider errors as visible failures', async () => {
    const provider = new MockProvider(async () => {
      throw new VisibleExtractionError('temporary outage', {
        code: 'provider-failed',
        retryable: true,
      });
    });

    const adapter = new FileBackedRemoteExtractionAdapter({
      providers: buildRegistry(provider),
      fileReader: new MemoryReader(),
      freshness: new AlwaysFresh(),
    });

    await expect(adapter.extract(source, settings)).rejects.toMatchObject({
      name: 'VisibleExtractionError',
      retryable: true,
    });
  });
});
