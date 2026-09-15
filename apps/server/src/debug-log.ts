import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';

import { device, requireDevice } from './auth.ts';
import { intQuery, withServerTime } from './http/reply.ts';

export type DebugValue = string | number | boolean | null | DebugValue[] | { [key: string]: DebugValue };

export interface ServerDebugEntry {
  id: number;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  source: 'server';
  message: string;
  details: Record<string, DebugValue>;
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
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (path === '/debug/logs') return payload;

    const status = reply.statusCode;
    appendServerDebug(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', `${request.method} ${path}`, {
      durationMs: Math.round(reply.elapsedTime),
      deviceId: request.device?.deviceId ?? null,
      request: {
        method: request.method,
        url: redactUrl(request.url),
        headers: redactHeaders(request.headers),
        body: captureBody(request.body, request.headers['content-type'], path),
      },
      response: {
        status,
        headers: redactHeaders(reply.getHeaders()),
        body: captureBody(payload, reply.getHeader('content-type'), path),
      },
    });
    return payload;
  });

  app.get<{ Querystring: { limit?: string } }>(
    '/debug/logs',
    { preHandler: requireDevice },
    async (request) => {
      const limit = intQuery(request.query, 'limit', { min: 1, max: MAX_ENTRIES, default: MAX_ENTRIES });
      return withServerTime({
        entries: entries.slice(-limit).reverse(),
        capacity: MAX_ENTRIES,
      });
    },
  );

  app.delete('/debug/logs', { preHandler: requireDevice }, async (request, reply) => {
    device(request);
    entries.length = 0;
    return reply.code(204).send();
  });
}

function redactHeaders(headers: Record<string, unknown>): Record<string, DebugValue> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => [name, isSensitiveKey(name) ? '[redacted]' : toDebugValue(value)]),
  );
}

function redactUrl(rawUrl: string): string {
  const url = new URL(rawUrl, 'http://localhost');
  for (const key of url.searchParams.keys()) {
    if (isSensitiveKey(key) || key.toLowerCase() === 'code') url.searchParams.set(key, '[redacted]');
  }
  return `${url.pathname}${url.search}`;
}

function captureBody(value: unknown, contentType: unknown, requestPath: string): DebugValue {
  if (value === undefined || value === null || value === '') return null;
  const type = String(contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

  if (Buffer.isBuffer(value)) {
    if (type === 'application/json') return parseAndRedact(value.toString('utf8'), requestPath);
    if (type.startsWith('text/') || type === 'application/javascript') return value.toString('utf8');
    return { type: type || 'application/octet-stream', byteLength: value.byteLength, content: '[binary]' };
  }
  if (typeof value === 'string') {
    if (type === 'application/json' || type.endsWith('+json')) return parseAndRedact(value, requestPath);
    return value;
  }
  if (isReadable(value)) return { type: type || 'application/octet-stream', content: '[stream]' };
  return redactValue(value, [], requestPath);
}

function parseAndRedact(value: string, requestPath: string): DebugValue {
  try {
    return redactValue(JSON.parse(value), [], requestPath);
  } catch {
    return value;
  }
}

function redactValue(value: unknown, parents: string[], requestPath: string, key = ''): DebugValue {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const withinSecrets = parents.some((part) => part.replace(/[^a-z0-9]/gi, '').toLowerCase() === 'secrets');
  const pairingCode = normalizedKey === 'code' && requestPath.startsWith('/auth/pair');
  if (
    isSensitiveKey(normalizedKey) ||
    pairingCode ||
    normalizedKey === 'qrimage' ||
    normalizedKey === 'pairingpayload' ||
    (normalizedKey === 'value' && (requestPath.startsWith('/secrets') || withinSecrets))
  ) {
    return '[redacted]';
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, [...parents, key], requestPath));
  if (Buffer.isBuffer(value)) return { type: 'application/octet-stream', byteLength: value.byteLength, content: '[binary]' };
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redactValue(child, [...parents, key], requestPath, childKey),
      ]),
    );
  }
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'authorization',
    'cookie',
    'setcookie',
    'password',
    'apikey',
    'aiapikey',
    'apiverketapikey',
    'token',
    'accesstoken',
    'refreshtoken',
    'devicetoken',
  ].includes(normalized);
}

function toDebugValue(value: unknown): DebugValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toDebugValue);
  return String(value);
}

function isReadable(value: unknown): value is Readable {
  return Boolean(value && typeof value === 'object' && 'pipe' in value);
}