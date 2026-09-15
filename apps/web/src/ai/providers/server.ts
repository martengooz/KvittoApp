/**
 * Routes extraction through the companion server, so the provider key stays on
 * the server and never touches the phone.
 *
 * The server runs the same prompt, schema and normaliser as the in-app
 * providers (all three now call the same `@kvitto/shared` provider core), so
 * results are identical to calling the provider directly — only the trust
 * boundary moves.
 */

import { describeNetworkError, normalizeExtraction, type NormalizedExtraction } from '@kvitto/shared';

import {
  ExtractionError,
  type ExtractionRequest,
  type ExtractionResponse,
  type Provider,
  type TestResult,
} from '../types.js';

interface ProxyResponse {
  raw?: Record<string, unknown>;
  extraction?: NormalizedExtraction;
  model?: string;
  provider?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  structuredOutputFallback?: boolean;
  error?: string;
  message?: string;
}

export const serverProvider: Provider = {
  id: 'server',

  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    const { serverUrl, serverToken, image, settings, signal } = request;
    if (!serverUrl) throw new ExtractionError('Ingen server-URL angiven.');
    if (!serverToken) throw new ExtractionError('Enheten är inte parkopplad med servern.');

    const started = performance.now();
    const form = new FormData();
    form.append('image', image, 'receipt.jpg');
    // The server decides the final model, but an explicit preference is honoured
    // when the operator has allow-listed it.
    if (settings.model) form.append('model', settings.model);
    if (settings.extraInstructions) form.append('extraInstructions', settings.extraInstructions);
    // The server's own configured effort/token budget wins unless it chooses to
    // honour these — sent so a future server can, without the device needing to
    // change. Forwarding them is what device-set values are for; dropping them
    // silently is the bug this fixes.
    if (settings.effort && settings.effort !== 'auto') form.append('effort', settings.effort);
    if (settings.maxOutputTokens) form.append('maxOutputTokens', String(settings.maxOutputTokens));

    let response: Response;
    try {
      response = await fetch(`${serverUrl.replace(/\/+$/, '')}/ai/parse`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serverToken}` },
        body: form,
        signal: signal ?? null,
      });
    } catch (error) {
      throw new ExtractionError(describeNetworkError(error), { cause: error, retryable: true });
    }

    const payload = (await response.json().catch(() => ({}))) as ProxyResponse;
    if (!response.ok) {
      throw new ExtractionError(
        payload.message ?? payload.error ?? `Servern svarade ${response.status}.`,
        { status: response.status, retryable: response.status >= 500 },
      );
    }
    if (!payload.raw) throw new ExtractionError('Servern returnerade inget resultat.');

    return {
      // Prefer the server's own normalisation; fall back for an older server
      // that only ever returned `raw`.
      extraction: payload.extraction ?? normalizeExtraction(payload.raw),
      raw: payload.raw,
      model: payload.model ?? settings.model,
      provider: `server:${payload.provider ?? 'unknown'}`,
      inputTokens: payload.inputTokens ?? null,
      outputTokens: payload.outputTokens ?? null,
      durationMs: Math.round(performance.now() - started),
      structuredOutputFallback: payload.structuredOutputFallback ?? false,
    };
  },

  async test(request): Promise<TestResult> {
    const { serverUrl, serverToken } = request;
    if (!serverUrl) return { ok: false, message: 'Ingen server-URL angiven.' };
    if (!serverToken) return { ok: false, message: 'Enheten är inte parkopplad med servern.' };

    try {
      const response = await fetch(`${serverUrl.replace(/\/+$/, '')}/auth/me`, {
        headers: { authorization: `Bearer ${serverToken}` },
      });
      if (!response.ok) return { ok: false, message: `Servern svarade ${response.status}.` };

      const payload = (await response.json()) as {
        aiProxyEnabled?: boolean;
        aiProxyModels?: string[];
      };
      if (!payload.aiProxyEnabled) {
        return {
          ok: false,
          message: 'Servern är nåbar men har ingen AI-proxy konfigurerad.',
        };
      }
      return {
        ok: true,
        message: `Ansluten. Servern tolkar kvitton åt dig.`,
        models: payload.aiProxyModels ?? [],
      };
    } catch (error) {
      return { ok: false, message: describeNetworkError(error) };
    }
  },
};
