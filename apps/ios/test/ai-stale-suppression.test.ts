import { describe, expect, test } from '@jest/globals';

import { FileBackedRemoteExtractionAdapter } from '../src/ai/remote-extraction-adapter';
import { ProviderCapabilityRegistry } from '../src/ai/capability-registry';
import type { FileSourceReader, ProviderCapabilities, ProviderRequest, ProviderResponse, RemoteExtractionProvider, SourceFreshness } from '../src/ai/types';

class MemoryReader implements FileSourceReader {
  async readBytes(): Promise<Uint8Array> {
    return new Uint8Array([9, 8, 7]);
  }
}

class StaleAfterFirstCheck implements SourceFreshness {
  private calls = 0;

  async isCurrent(): Promise<boolean> {
    this.calls += 1;
    return this.calls === 1;
  }
}

class ProviderStub implements RemoteExtractionProvider {
  readonly id = 'openai' as const;
  public calls = 0;

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
      supportsCorrection: false,
      requiresApiKey: true,
      requiresBaseUrl: false,
    };
  }

  async extractV1(_request: ProviderRequest): Promise<ProviderResponse> {
    this.calls += 1;
    return {
      raw: {
        merchant: { name: 'Coop' },
        purchasedAt: '2026-05-09 09:10',
        currency: 'SEK',
        total: '25,00',
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
        items: [{ name: 'Brod', quantity: '1', unit: 'st', unitPrice: '25,00', totalPrice: '25,00', rawName: null, discount: null, vatRate: null, ean: null, deposit: null }],
        confidence: 0.9,
      },
      model: 'gpt-test',
      provider: 'openai',
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 40,
    };
  }
}

describe('ai stale source suppression', () => {
  test('suppresses output when source turns stale mid-flight', async () => {
    const provider = new ProviderStub();
    const registry = new ProviderCapabilityRegistry();
    registry.register(provider);

    const adapter = new FileBackedRemoteExtractionAdapter({
      providers: registry,
      fileReader: new MemoryReader(),
      freshness: new StaleAfterFirstCheck(),
    });

    const outcome = await adapter.extract(
      {
        sourceId: 'receipt-4',
        revision: 11,
        filePath: '/tmp/r4.jpg',
      },
      {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'key',
        baseUrl: '',
        maxOutputTokens: 4000,
        effort: 'auto',
        structuredOutput: true,
        extraInstructions: '',
      },
    );

    expect(outcome.status).toBe('stale-suppressed');
    expect(provider.calls).toBe(1);
  });
});
