/**
 * KvittoApp companion server.
 *
 * A deliberately small sync relay: it stores what the devices send, hands back
 * what changed, keeps the images, and optionally proxies AI extraction so the
 * provider key never has to live on a phone. It is not a second source of
 * truth — every device holds the complete archive, and the server can be
 * rebuilt from any one of them.
 */

import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';

import { SYNC_PROTOCOL_VERSION } from '@kvitto/shared';

import { ensureDefaultAccount } from './db/accounts.ts';
import { closeDatabase, getConnection } from './db/index.ts';
import { aiProxyEnabled, config, llmEnabled } from './env.ts';
import { shutdown as shutdownLlm, status as llmStatus } from './llm/runtime.ts';
import { startWorker, stopWorker } from './llm/worker.ts';
import { registerAiRoutes } from './routes/ai.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBlobRoutes } from './routes/blobs.ts';
import { registerLlmRoutes } from './routes/llm.ts';
import { registerSyncRoutes } from './routes/sync.ts';

export async function buildServer() {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustProxy,
  });

  await app.register(cors, {
    // An explicit allow-list when configured; otherwise reflect the caller's
    // origin, which is what a LAN or VPN deployment needs. The startup banner
    // warns when this is left open.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type'],
    maxAge: 86400,
  });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    // Devices share an IP behind NAT, so limit per device token where possible.
    keyGenerator: (request) => request.headers.authorization ?? request.ip,
  });

  await app.register(multipart, {
    limits: { fileSize: config.maxBlobBytes, files: 1, fields: 8 },
  });

  // Raw image uploads: `PUT /blobs/:id` sends bytes, not JSON.
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(type, { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get('/health', async () => ({
    ok: true,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    aiProxyEnabled: aiProxyEnabled(),
    llmEnabled: llmEnabled(),
    llmState: llmEnabled() ? llmStatus().state : 'off',
    serverTime: Date.now(),
  }));

  registerAuthRoutes(app);
  registerSyncRoutes(app);
  registerBlobRoutes(app);
  registerAiRoutes(app);
  registerLlmRoutes(app);

  if (config.staticDir) registerStatic(app, config.staticDir);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error({ error }, 'request failed');
    // Never surface an internal error message to a client; it can carry paths
    // and configuration detail.
    void reply.code(status).send({
      error: status >= 500 ? 'internal_error' : (error.code ?? 'request_failed'),
      message: status >= 500 ? 'Ett internt fel inträffade.' : error.message,
    });
  });

  return app;
}

/**
 * Serves the built PWA, when `KVITTO_STATIC_DIR` points at one.
 *
 * Hand-rolled rather than `@fastify/static`: the needs are a handful of file
 * types and an SPA fallback, and one fewer dependency in a self-hosted server
 * is worth more than the plugin's extra features.
 */
function registerStatic(app: FastifyInstance, root: string): void {
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  };

  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET') {
      return reply.code(404).send({ error: 'not_found', message: 'Okänd endpoint.' });
    }

    const requested = decodeURIComponent(request.url.split('?')[0] ?? '/');
    // `normalize` collapses `..`, and the prefix check rejects anything that
    // still escapes the root — a static handler is the classic traversal hole.
    const candidate = normalize(join(root, requested === '/' ? 'index.html' : requested));
    if (!candidate.startsWith(root)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Otillåten sökväg.' });
    }

    try {
      const body = readFileSync(candidate);
      const type = MIME[extname(candidate)] ?? 'application/octet-stream';
      // The service worker must never be cached, or clients get stuck on an
      // old build with no way to update.
      const cacheControl = candidate.endsWith('sw.js')
        ? 'no-cache'
        : requested.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
      return reply.header('content-type', type).header('cache-control', cacheControl).send(body);
    } catch {
      // Unknown path with no file: hand back the shell so client routing works.
      try {
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-cache')
          .send(readFileSync(join(root, 'index.html')));
      } catch {
        return reply.code(404).send({ error: 'not_found', message: 'Hittades inte.' });
      }
    }
  });
}

async function main(): Promise<void> {
  getConnection();
  const accountId = ensureDefaultAccount();

  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });

  app.log.info(
    {
      account: accountId,
      database: config.databasePath,
      blobs: config.blobDir,
      aiProxy: aiProxyEnabled() ? config.ai.provider : 'disabled',
      localModel: llmEnabled() ? config.llm.model : 'disabled',
      staticDir: config.staticDir ?? 'none',
    },
    'KvittoApp server ready',
  );

  // Started after `listen`, so a model download never delays the port opening.
  if (llmEnabled()) {
    startWorker(accountId, (message, data) => app.log.info(data ?? {}, message));
  }

  if (config.corsOrigins.length === 0) {
    app.log.warn(
      'KVITTO_CORS_ORIGINS is unset, so any website may call this server with a stolen ' +
        'token. Set it to your app origin before exposing this to the internet.',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    stopWorker();
    await app.close();
    // Only ever stops an instance this process started; one the user is running
    // themselves is left alone.
    await shutdownLlm();
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only start listening when run directly, so tests can import `buildServer`.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((error: unknown) => {
    console.error('Failed to start KvittoApp server:', error);
    process.exit(1);
  });
}
