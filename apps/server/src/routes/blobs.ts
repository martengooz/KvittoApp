/** Image upload and download, addressed by SHA-256. */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { BlobStatusRequest } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { blobExists, isValidBlobId, readBlob, storeBlob } from '../blobs.ts';
import { getDb, schema } from '../db/index.ts';
import { config } from '../env.ts';

/** Media types a receipt scan can legitimately be. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function registerBlobRoutes(app: FastifyInstance): void {
  /**
   * Tells a client which digests the server already has, so identical images
   * from a second device are never re-uploaded.
   */
  app.post<{ Body: BlobStatusRequest }>(
    '/blobs/status',
    {
      preHandler: requireDevice,
      schema: {
        body: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: { type: 'array', maxItems: 500, items: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const present: string[] = [];
      const missing: string[] = [];
      for (const id of request.body.ids) {
        if (isValidBlobId(id) && blobExists(id)) present.push(id);
        else missing.push(id);
      }
      return reply.send({ present, missing });
    },
  );

  app.put<{ Params: { id: string } }>(
    '/blobs/:id',
    {
      preHandler: requireDevice,
      bodyLimit: config.maxBlobBytes,
    },
    async (request, reply) => {
      const context = device(request);
      const { id } = request.params;

      if (!isValidBlobId(id)) {
        return reply.code(400).send({ error: 'invalid_id', message: 'Blob-id måste vara SHA-256 i hex.' });
      }

      const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      if (!ALLOWED_TYPES.has(contentType)) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: `Endast ${[...ALLOWED_TYPES].join(', ')} stöds.`,
        });
      }

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({ error: 'invalid_body', message: 'Förväntade binärdata.' });
      }

      const result = await storeBlob(id, body);
      if (!result.ok) {
        return reply.code(409).send({
          error: 'digest_mismatch',
          message: result.mismatch
            ? `Innehållet hashar till ${result.mismatch.actual}, inte ${result.mismatch.expected}.`
            : 'Kunde inte spara bilden.',
        });
      }

      // Record ownership so a future cleanup pass knows which account a file
      // belongs to; the file itself is shared by digest.
      getDb()
        .insert(schema.blobs)
        .values({
          id,
          accountId: context.accountId,
          byteSize: body.length,
          mimeType: contentType,
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();

      return reply.code(201).send({ id, byteSize: body.length });
    },
  );

  app.get<{ Params: { id: string } }>('/blobs/:id', { preHandler: requireDevice }, async (request, reply) => {
    const context = device(request);
    const { id } = request.params;
    if (!isValidBlobId(id)) {
      return reply.code(400).send({ error: 'invalid_id', message: 'Ogiltigt blob-id.' });
    }

    const record = getDb()
      .select()
      .from(schema.blobs)
      .where(and(eq(schema.blobs.id, id), eq(schema.blobs.accountId, context.accountId)))
      .limit(1)
      .all()[0];

    // Files are content-addressed and therefore shared, but a device may only
    // fetch digests its own account uploaded.
    if (!record) return reply.code(404).send({ error: 'not_found', message: 'Bilden finns inte.' });

    const data = await readBlob(id);
    if (!data) return reply.code(404).send({ error: 'not_found', message: 'Bilden finns inte på disk.' });

    return reply
      .header('content-type', record.mimeType)
      // Content-addressed bytes never change, so this can be cached forever.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('etag', `"${id}"`)
      .send(data);
  });
}
