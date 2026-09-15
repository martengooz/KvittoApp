/** Image upload and download, addressed by SHA-256. */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { BlobStatusRequest } from '@kvitto/shared';

import { device, requireDevice } from '../auth.ts';
import { blobExists, isValidBlobId, readBlob, storeBlob } from '../blobs.ts';
import { getDb, schema } from '../db/index.ts';
import { config } from '../env.ts';
import { fail, isImageType, unsupportedMediaType } from '../http/reply.ts';

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
        return fail(reply, 400, 'invalid_id', 'Blob-id måste vara SHA-256 i hex.');
      }

      const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      if (!isImageType(contentType)) {
        return unsupportedMediaType(reply);
      }

      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return fail(reply, 400, 'invalid_body', 'Förväntade binärdata.');
      }

      const result = await storeBlob(id, body);
      if (!result.ok) {
        return fail(
          reply,
          409,
          'digest_mismatch',
          result.mismatch
            ? `Innehållet hashar till ${result.mismatch.actual}, inte ${result.mismatch.expected}.`
            : 'Kunde inte spara bilden.',
        );
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
      return fail(reply, 400, 'invalid_id', 'Blob-id måste vara SHA-256 i hex.');
    }

    const record = getDb()
      .select()
      .from(schema.blobs)
      .where(and(eq(schema.blobs.id, id), eq(schema.blobs.accountId, context.accountId)))
      .limit(1)
      .all()[0];

    // Files are content-addressed and therefore shared, but a device may only
    // fetch digests its own account uploaded.
    if (!record) return fail(reply, 404, 'not_found', 'Bilden finns inte.');

    const data = await readBlob(id);
    if (!data) return fail(reply, 404, 'not_found', 'Bilden finns inte på disk.');

    return reply
      .header('content-type', record.mimeType)
      // Content-addressed bytes never change, so this can be cached forever.
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('etag', `"${id}"`)
      .send(data);
  });
}
