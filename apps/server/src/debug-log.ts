import type { FastifyInstance } from 'fastify';

import { device, requireDevice } from './auth.ts';

export interface ServerDebugEntry {
  id: number;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  source: 'server';
  message: string;
  details: Record<string, string | number | boolean | null>;
}

const MAX_ENTRIES = 500;
const entries: ServerDebugEntry[] = [];
let nextId = 1;

export function appendServerDebug(
  level: ServerDebugEntry['level'],
  message: string,
  details: ServerDebugEntry['details'] = {},
): void {
  entries.push({ id: nextId, timestamp: Date.now(), level, source: 'server', message, details });
  nextId += 1;
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function registerDebugLog(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const status = reply.statusCode;
    appendServerDebug(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', `${request.method} ${path}`, {
      status,
      durationMs: Math.round(reply.elapsedTime),
      deviceId: request.device?.deviceId ?? null,
    });
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/debug/logs',
    { preHandler: requireDevice },
    async (request) => {
      const requested = Number.parseInt(request.query.limit ?? '200', 10);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_ENTRIES) : 200;
      return {
        entries: entries.slice(-limit).reverse(),
        capacity: MAX_ENTRIES,
        serverTime: Date.now(),
      };
    },
  );

  app.delete('/debug/logs', { preHandler: requireDevice }, async (request, reply) => {
    const currentDeviceId = device(request).deviceId;
    entries.length = 0;
    appendServerDebug('info', 'Server log cleared', { deviceId: currentDeviceId });
    return reply.code(204).send();
  });
}