/** The AI proxy endpoint, enabled only when the operator configures a key. */

import type { FastifyInstance } from 'fastify';

import type { CorrectionContext } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { runExtraction, ProxyError } from '../ai/proxy.ts';
import { AI_EFFORTS, effectiveAiSettings, type AiEffort } from '../db/server-settings.ts';
import { config } from '../env.ts';
import { fail, isImageType, unsupportedMediaType } from '../http/reply.ts';

/** Enough for a long receipt's previous attempt, far short of a runaway payload. */
const MAX_CORRECTION_BYTES = 64_000;
const MAX_CORRECTION_PROBLEMS = 20;

export function registerAiRoutes(app: FastifyInstance): void {
  app.post(
    '/ai/parse',
    {
      preHandler: requireDevice,
      // Extraction is the only expensive endpoint here — each call spends the
      // operator's money, so it gets its own tighter limit.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const ai = effectiveAiSettings(device(request).accountId);
      if (!ai.enabled) {
        return fail(reply, 501, 'ai_disabled', 'Servern har ingen AI-proxy konfigurerad.');
      }

      const parts = request.parts();
      let image: Buffer | null = null;
      let mimeType = 'image/jpeg';
      let model: string | undefined;
      let extraInstructions: string | undefined;
      let correction: CorrectionContext | null = null;
      let effort: AiEffort | undefined;
      let maxOutputTokens: number | undefined;

      for await (const part of parts) {
        if (part.type === 'file') {
          if (part.fieldname !== 'image') {
            // Drain unexpected file parts; leaving them unread stalls the stream.
            await part.toBuffer();
            continue;
          }
          image = await part.toBuffer();
          const type = part.mimetype.split(';')[0]?.trim() ?? '';
          if (!isImageType(type)) {
            return unsupportedMediaType(reply);
          }
          mimeType = type;
        } else if (part.fieldname === 'model') {
          model = String(part.value).trim();
        } else if (part.fieldname === 'extraInstructions') {
          extraInstructions = String(part.value).slice(0, 2000);
        } else if (part.fieldname === 'correction') {
          correction = parseCorrection(String(part.value));
        } else if (part.fieldname === 'effort') {
          const candidate = String(part.value).trim();
          if (AI_EFFORTS.includes(candidate as AiEffort)) effort = candidate as AiEffort;
        } else if (part.fieldname === 'maxOutputTokens') {
          const parsed = Number.parseInt(String(part.value), 10);
          if (Number.isFinite(parsed) && parsed > 0) maxOutputTokens = parsed;
        }
      }

      if (!image || image.length === 0) {
        return fail(reply, 400, 'missing_image', 'Ingen bild bifogades.');
      }
      if (image.length > config.maxBlobBytes) {
        return fail(reply, 413, 'image_too_large', 'Bilden är för stor.');
      }

      // A device must not be able to bill the operator for an arbitrary model.
      const permitted = ai.allowedModels;
      if (model && !permitted.includes(model)) {
        request.log.warn({ model }, 'device requested a model that is not allow-listed');
        model = undefined;
      }

      try {
        const result = await runExtraction(ai, image, mimeType, {
          model,
          extraInstructions,
          effort,
          maxOutputTokens,
          correction,
        });
        return reply.send(result);
      } catch (error) {
        if (error instanceof ProxyError) {
          return fail(reply, error.status, 'ai_failed', error.message);
        }
        request.log.error({ error }, 'AI proxy failed');
        return fail(reply, 502, 'ai_failed', 'AI-tolkningen misslyckades.');
      }
    },
  );
}

/**
 * Reads the correcting pass's context off a device's request.
 *
 * Everything here reaches a model prompt, so it is bounded rather than trusted:
 * a paired device is not hostile, but a bug on one should not be able to spend
 * the operator's tokens on a megabyte of "previous attempt". Anything
 * malformed is dropped and the request simply runs as an ordinary first pass.
 */
function parseCorrection(raw: string): CorrectionContext | null {
  if (raw.length > MAX_CORRECTION_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { problems, previous } = parsed as { problems?: unknown; previous?: unknown };
    if (!Array.isArray(problems)) return null;
    const cleaned = problems
      .filter((problem): problem is string => typeof problem === 'string')
      .slice(0, MAX_CORRECTION_PROBLEMS)
      .map((problem) => problem.slice(0, 500));
    if (cleaned.length === 0) return null;
    return { problems: cleaned, previous: previous ?? null };
  } catch {
    return null;
  }
}
