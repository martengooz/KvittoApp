/**
 * Server-side extraction, so a device can parse receipts without holding a
 * provider API key.
 *
 * Uses the same prompt and schema as the in-app providers, so results are
 * indistinguishable from calling the provider directly — only the trust
 * boundary moves.
 */

import {
  RECEIPT_JSON_SCHEMA,
  RECEIPT_USER_PROMPT,
  buildSystemPrompt,
  extractJsonObject,
  jsonOnlyInstruction,
} from '@kvitto/shared';

import { config } from '../env.ts';

export interface ProxyResult {
  raw: Record<string, unknown>;
  model: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export class ProxyError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
  }
}

export async function runExtraction(
  image: Buffer,
  mimeType: string,
  options: { model?: string; extraInstructions?: string } = {},
): Promise<ProxyResult> {
  const model = options.model ?? config.ai.model;
  const system = buildSystemPrompt(options.extraInstructions);

  switch (config.ai.provider) {
    case 'anthropic':
      return callAnthropic(image, mimeType, model, system);
    case 'openai':
    case 'openai-compatible':
      return callOpenAi(image, mimeType, model, system);
    default:
      throw new ProxyError(`Unsupported KVITTO_AI_PROVIDER "${config.ai.provider}".`, 500);
  }
}

async function callAnthropic(
  image: Buffer,
  mimeType: string,
  model: string,
  system: string,
): Promise<ProxyResult> {
  const response = await fetch(`${config.ai.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.ai.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: config.ai.maxOutputTokens,
      system,
      output_config: { format: { type: 'json_schema', schema: RECEIPT_JSON_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: image.toString('base64') } },
            { type: 'text', text: RECEIPT_USER_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!response.ok) throw await providerError(response);

  const payload = (await response.json()) as {
    content?: { type: string; text?: string }[];
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  if (payload.stop_reason === 'refusal') {
    throw new ProxyError('Modellen avböjde att läsa bilden.', 422);
  }

  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');

  const raw = extractJsonObject(text);
  if (!raw) throw new ProxyError('Modellen svarade inte med giltig JSON.', 502);

  return {
    raw,
    model: payload.model ?? model,
    provider: 'anthropic',
    inputTokens: payload.usage?.input_tokens ?? null,
    outputTokens: payload.usage?.output_tokens ?? null,
  };
}

async function callOpenAi(
  image: Buffer,
  mimeType: string,
  model: string,
  system: string,
): Promise<ProxyResult> {
  const baseUrl = (config.ai.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const dataUrl = `data:${mimeType};base64,${image.toString('base64')}`;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: config.ai.maxOutputTokens,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'receipt', strict: true, schema: RECEIPT_JSON_SCHEMA },
      },
      messages: [
        { role: 'system', content: `${system}\n\n${jsonOnlyInstruction(RECEIPT_JSON_SCHEMA)}` },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            { type: 'text', text: RECEIPT_USER_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!response.ok) throw await providerError(response);

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const raw = extractJsonObject(payload.choices?.[0]?.message?.content ?? '');
  if (!raw) throw new ProxyError('Modellen svarade inte med giltig JSON.', 502);

  return {
    raw,
    model: payload.model ?? model,
    provider: config.ai.provider,
    inputTokens: payload.usage?.prompt_tokens ?? null,
    outputTokens: payload.usage?.completion_tokens ?? null,
  };
}

/**
 * Turns a provider error into one safe to return to a device.
 *
 * Upstream bodies can echo request headers, so only the status and a short
 * message are forwarded — never the raw response.
 */
async function providerError(response: Response): Promise<ProxyError> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    const message = typeof body.error === 'string' ? body.error : body.error?.message;
    if (message) detail = message.slice(0, 300);
  } catch {
    // Non-JSON error body; the status line is enough.
  }

  if (response.status === 401 || response.status === 403) {
    // Never leak whether the operator's key is wrong versus merely unauthorised
    // for this model — the device cannot fix either.
    return new ProxyError('Serverns AI-nyckel avvisades. Kontakta administratören.', 502);
  }
  if (response.status === 429) return new ProxyError('AI-tjänsten är hastighetsbegränsad just nu.', 429);
  return new ProxyError(detail, 502);
}
