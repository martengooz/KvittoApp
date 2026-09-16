import { describe, expect, test } from '@jest/globals';

import { FoundationModelsProvider } from '../src/ai/foundation-models-provider';

describe('foundation models provider stub', () => {
  test('reports availability and refuses v1 extraction', async () => {
    const provider = new FoundationModelsProvider({
      isRuntimeAvailable: () => true,
    });

    const caps = await provider.getCapabilities();
    expect(caps.available).toBe(true);
    expect(caps.supportsExtractionV1).toBe(false);
    expect(caps.supportsStructuredOutput).toBe(true);

    await expect(
      provider.extractV1({
        model: 'apple.foundation.latest',
        imageBase64: 'Zm9v',
        mimeType: 'image/jpeg',
        maxOutputTokens: 1200,
        effort: 'auto',
        structuredOutput: true,
        extraInstructions: '',
      }),
    ).rejects.toMatchObject({
      name: 'VisibleExtractionError',
      code: 'foundation-v1-not-supported',
      retryable: false,
    });
  });
});
