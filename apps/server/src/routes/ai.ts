/** The AI proxy endpoint, enabled only when the operator configures a key. */

import type { FastifyInstance } from 'fastify';

import { requireDevice } from '../auth.ts';
import { runExtraction, ProxyError } from '../ai/proxy.ts';
import { aiProxyEnabled, allowedModels, config } from '../env.ts';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
      if (!aiProxyEnabled()) {
        return reply.code(501).send({
          error: 'ai_disabled',
          message: 'Servern har ingen AI-proxy konfigurerad.',
        });
      }

      const parts = request.parts();
      let image: Buffer | null = null;
      let mimeType = 'image/jpeg';
      let model: string | undefined;
      let extraInstructions: string | undefined;

      for await (const part of parts) {
        if (part.type === 'file') {
          if (part.fieldname !== 'image') {
            // Drain unexpected file parts; leaving them unread stalls the stream.
            await part.toBuffer();
            continue;
          }
          image = await part.toBuffer();
          const type = part.mimetype.split(';')[0]?.trim() ?? '';
          if (!ALLOWED_TYPES.has(type)) {
            return reply.code(415).send({
              error: 'unsupported_media_type',
              message: `Endast ${[...ALLOWED_TYPES].join(', ')} stöds.`,
            });
          }
          mimeType = type;
        } else if (part.fieldname === 'model') {
          model = String(part.value).trim();
        } else if (part.fieldname === 'extraInstructions') {
          extraInstructions = String(part.value).slice(0, 2000);
        }
      }

      if (!image || image.length === 0) {
        return reply.code(400).send({ error: 'missing_image', message: 'Ingen bild bifogades.' });
      }
      if (image.length > config.maxBlobBytes) {
        return reply.code(413).send({ error: 'image_too_large', message: 'Bilden är för stor.' });
      }

      // A device must not be able to bill the operator for an arbitrary model.
      const permitted = allowedModels();
      if (model && !permitted.includes(model)) {
        request.log.warn({ model }, 'device requested a model that is not allow-listed');
        model = undefined;
      }

      try {
        const result = await runExtraction(image, mimeType, { model, extraInstructions });
        return reply.send(result);
      } catch (error) {
        if (error instanceof ProxyError) {
          return reply.code(error.status).send({ error: 'ai_failed', message: error.message });
        }
        request.log.error({ error }, 'AI proxy failed');
        return reply.code(502).send({ error: 'ai_failed', message: 'AI-tolkningen misslyckades.' });
      }
    },
  );
}
