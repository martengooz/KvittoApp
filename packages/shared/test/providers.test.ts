/**
 * The shared provider core: the plumbing every Anthropic/OpenAI/Ollama call
 * goes through now, exercised against a fake HTTP server rather than a real
 * provider (same approach as the server's `llm.test.ts` fake Ollama).
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';

import {
  JSON_INVALID_MESSAGE,
  ProviderError,
  callAnthropic,
  callOllama,
  callOpenAi,
  isRetryableStatus,
  parseModelJson,
  providerErrorForResponse,
  sendWithStructuredFallback,
  timedFetch,
  withRetry,
} from '../dist/index.js';

// --- a tiny scriptable HTTP server, reused across the integration-style tests ---

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

let server: Server;
let baseUrl = '';
let handler: Handler = (_request, _body, response) => {
  response.writeHead(500).end('no handler configured');
};
let requests: { url: string; method: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        url: request.url ?? '',
        method: request.method ?? 'GET',
        headers: request.headers,
        body: body ? JSON.parse(body) : null,
      });
      handler(request, body, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  handler = (_request, _body, response) => {
    response.writeHead(500).end('no handler configured');
  };
});

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const IMAGE = { base64: 'Zm9v', mediaType: 'image/jpeg' };

// --- low-level helpers ---

void test('timedFetch turns an expired deadline into a retryable ProviderError', async () => {
  handler = (_request, _body, response) => {
    // Never responds within the test's timeout.
    const timer = setTimeout(() => response.writeHead(200).end('{}'), 300);
    response.on('close', () => clearTimeout(timer));
  };

  await assert.rejects(
    () => timedFetch(`${baseUrl}/slow`, {}, { timeoutMs: 30 }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'timeout');
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

void test('timedFetch succeeds well within its deadline', async () => {
  handler = (_request, _body, response) => json(response, 200, { ok: true });
  const response = await timedFetch(`${baseUrl}/fast`, {}, { timeoutMs: 5000 });
  assert.equal(response.status, 200);
});

void test('withRetry retries a 429 and returns the eventual success', async () => {
  let calls = 0;
  handler = (_request, _body, response) => {
    calls += 1;
    if (calls < 3) return json(response, 429, { error: 'slow down' });
    return json(response, 200, { ok: true });
  };

  const response = await withRetry(() => fetch(`${baseUrl}/retry`, { method: 'POST' }), {
    attempts: 3,
    isRetryable: isRetryableStatus,
    backoffMs: () => 1,
  });

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

void test('withRetry gives up after its attempt budget and returns the last failure', async () => {
  let calls = 0;
  handler = (_request, _body, response) => {
    calls += 1;
    json(response, 500, { error: 'still down' });
  };

  const response = await withRetry(() => fetch(`${baseUrl}/give-up`, { method: 'POST' }), {
    attempts: 3,
    isRetryable: isRetryableStatus,
    backoffMs: () => 1,
  });

  assert.equal(response.status, 500);
  assert.equal(calls, 3, 'exactly the attempt budget, no more');
});

void test('withRetry does not retry a non-retryable status', async () => {
  let calls = 0;
  handler = (_request, _body, response) => {
    calls += 1;
    json(response, 400, { error: 'bad request' });
  };

  const response = await withRetry(() => fetch(`${baseUrl}/no-retry`, { method: 'POST' }), {
    attempts: 3,
    isRetryable: isRetryableStatus,
    backoffMs: () => 1,
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 1, 'a 400 is not retryable, so only the first attempt runs');
});

void test('sendWithStructuredFallback retries once with plain-prompt JSON on a schema rejection', async () => {
  const seen: boolean[] = [];
  const send = async (structured: boolean): Promise<Response> => {
    seen.push(structured);
    return structured
      ? new Response(JSON.stringify({ error: 'schema not supported' }), { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const { response, structuredOutputFallback } = await sendWithStructuredFallback(true, send);
  assert.equal(response.status, 200);
  assert.equal(structuredOutputFallback, true);
  assert.deepEqual(seen, [true, false]);
});

void test('sendWithStructuredFallback does not retry when structured output was never requested', async () => {
  const seen: boolean[] = [];
  const send = async (structured: boolean): Promise<Response> => {
    seen.push(structured);
    return new Response(JSON.stringify({ error: 'nope' }), { status: 400 });
  };

  const { response, structuredOutputFallback } = await sendWithStructuredFallback(false, send);
  assert.equal(response.status, 400);
  assert.equal(structuredOutputFallback, false);
  assert.deepEqual(seen, [false]);
});

void test('sendWithStructuredFallback does not retry a failure unrelated to the schema', async () => {
  const seen: boolean[] = [];
  const send = async (structured: boolean): Promise<Response> => {
    seen.push(structured);
    return new Response(JSON.stringify({ error: 'nope' }), { status: 401 });
  };

  const { response } = await sendWithStructuredFallback(true, send);
  assert.equal(response.status, 401);
  assert.deepEqual(seen, [true], 'a 401 is an auth failure, not a schema rejection');
});

void test('providerErrorForResponse maps the status codes every provider shares', async () => {
  const cases: [number, RegExp, boolean][] = [
    [401, /API-nyckeln avvisades/, false],
    [403, /behörighet/, false],
    [413, /för stor/, false],
    [429, /Hastighetsbegränsad/, true],
    [500, /serverfel/, true],
    [503, /serverfel/, true],
  ];

  for (const [status, pattern, retryable] of cases) {
    const response = new Response(JSON.stringify({ error: { message: 'detail' } }), { status });
    const error = await providerErrorForResponse(response);
    assert.match(error.message, pattern, `status ${status}`);
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable, `status ${status} retryable`);
  }
});

void test('providerErrorForResponse honours a 404 override', async () => {
  const response = new Response('not found', { status: 404 });
  const generic = await providerErrorForResponse(response);
  assert.match(generic.message, /Modellen eller endpointen/);

  const overridden = await providerErrorForResponse(new Response('not found', { status: 404 }), {
    notFound: 'Kör "ollama pull x".',
  });
  assert.equal(overridden.message, 'Kör "ollama pull x".');
});

void test('parseModelJson extracts a fenced JSON block and fails the same way everywhere when there is none', () => {
  const parsed = parseModelJson('Here you go:\n```json\n{"total": 1}\n```');
  assert.deepEqual(parsed, { total: 1 });

  assert.throws(
    () => parseModelJson('sorry, I cannot read this receipt'),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message, JSON_INVALID_MESSAGE);
      return true;
    },
  );
});

// --- the three provider call functions, end to end against the fake server ---

const RECEIPT = { merchant: { name: 'Test' }, total: '10,00', items: [] };

void test('callAnthropic sends the documented request shape and retries a 429', async () => {
  let calls = 0;
  handler = (_request, _body, response) => {
    calls += 1;
    if (calls === 1) return json(response, 429, { error: { message: 'rate limited' } });
    json(response, 200, {
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(RECEIPT) }],
      usage: { input_tokens: 12, output_tokens: 34 },
    });
  };

  const result = await callAnthropic({
    apiKey: 'sk-ant-test',
    baseUrl,
    model: 'claude-sonnet-5',
    image: IMAGE,
    maxOutputTokens: 1024,
    effort: 'high',
    structuredOutput: true,
    signal: undefined,
    timeoutMs: 5000,
  });

  assert.equal(calls, 2, 'the 429 was retried once');
  assert.deepEqual(result.raw, RECEIPT);
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 34);
  assert.equal(result.structuredOutputFallback, false);

  const sent = requests.at(-1)!;
  assert.equal(sent.url, '/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-ant-test');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  const body = sent.body as {
    output_config?: { format?: { type: string }; effort?: string };
    messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[];
  };
  assert.equal(body.output_config?.format?.type, 'json_schema');
  assert.equal(body.output_config?.effort, 'high');
  assert.equal(body.messages[0]?.content[0]?.type, 'image');
  assert.equal(body.messages[0]?.content[0]?.source?.media_type, 'image/jpeg');
  assert.equal(body.messages[0]?.content[0]?.source?.data, 'Zm9v');
});

void test('callAnthropic falls back to plain-prompt JSON when the schema is rejected', async () => {
  let calls = 0;
  handler = (_request, _body, response) => {
    calls += 1;
    if (calls === 1) return json(response, 400, { error: { message: 'output_config.format not supported' } });
    json(response, 200, {
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: JSON.stringify(RECEIPT) }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
  };

  const result = await callAnthropic({
    apiKey: 'k',
    baseUrl,
    model: 'claude-haiku-4-5',
    image: IMAGE,
    maxOutputTokens: 512,
    structuredOutput: true,
    timeoutMs: 5000,
  });

  assert.equal(result.structuredOutputFallback, true);
  assert.equal(calls, 2);
  const secondBody = requests.at(-1)!.body as { system: string; output_config?: unknown };
  assert.equal(secondBody.output_config, undefined, 'the fallback attempt drops the schema entirely');
  assert.match(secondBody.system, /JSON Schema/, 'the schema moves into the prompt instead');
});

void test('callAnthropic turns a refusal into a clear error', async () => {
  handler = (_request, _body, response) =>
    json(response, 200, { model: 'claude-sonnet-5', stop_reason: 'refusal', content: [] });

  await assert.rejects(
    () =>
      callAnthropic({
        apiKey: 'k',
        baseUrl,
        model: 'claude-sonnet-5',
        image: IMAGE,
        maxOutputTokens: 100,
        structuredOutput: false,
        timeoutMs: 5000,
      }),
    /avböjde/,
  );
});

void test('callOpenAi sends reasoning_effort and json_schema, and maps a 404 helpfully', async () => {
  handler = (_request, _body, response) => json(response, 404, { error: { message: 'model not found' } });

  await assert.rejects(
    () =>
      callOpenAi({
        apiKey: 'k',
        baseUrl,
        model: 'gpt-4o',
        image: IMAGE,
        maxOutputTokens: 100,
        effort: 'medium',
        structuredOutput: true,
        timeoutMs: 5000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 404);
      assert.match(error.message, /bas-URL och modellnamn/);
      return true;
    },
  );

  const sent = requests.at(-1)!.body as { reasoning_effort?: string; response_format?: { type: string } };
  assert.equal(sent.reasoning_effort, 'medium');
  assert.equal(sent.response_format?.type, 'json_schema');
});

void test('callOpenAi reports a truncated response as retryable', async () => {
  handler = (_request, _body, response) =>
    json(response, 200, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] });

  await assert.rejects(
    () =>
      callOpenAi({
        apiKey: 'k',
        baseUrl,
        model: 'gpt-4o',
        image: IMAGE,
        maxOutputTokens: 16,
        structuredOutput: false,
        timeoutMs: 5000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /Max tokens/);
      return true;
    },
  );
});

void test('callOllama constrains the schema via `format` and falls back on a 400', async () => {
  let calls = 0;
  handler = (_request, _body, response) => {
    calls += 1;
    if (calls === 1) return json(response, 400, { error: 'this model does not support format' });
    json(response, 200, {
      model: 'qwen3-vl:4b',
      message: { content: JSON.stringify(RECEIPT) },
      prompt_eval_count: 5,
      eval_count: 7,
    });
  };

  const result = await callOllama({
    baseUrl,
    model: 'qwen3-vl:4b',
    images: [IMAGE.base64],
    maxOutputTokens: 2048,
    contextTokens: 8192,
    structuredOutput: true,
    compactPrompt: true,
    timeoutMs: 5000,
  });

  assert.equal(calls, 2);
  assert.equal(result.structuredOutputFallback, true);
  assert.equal(result.inputTokens, 5);
  assert.equal(result.outputTokens, 7);

  const firstBody = requests[0]!.body as { format?: unknown; options: { num_ctx: number } };
  assert.ok(firstBody.format, 'the structured attempt carries the JSON Schema in `format`');
  assert.equal(firstBody.options.num_ctx, 8192);
  const secondBody = requests[1]!.body as { format?: unknown };
  assert.equal(secondBody.format, undefined, 'the fallback attempt drops `format`');
});

void test('callOllama maps a 404 to the "ollama pull" hint', async () => {
  handler = (_request, _body, response) => json(response, 404, { error: 'not found' });

  await assert.rejects(
    () =>
      callOllama({
        baseUrl,
        model: 'qwen3-vl:4b',
        images: [IMAGE.base64],
        maxOutputTokens: 100,
        structuredOutput: true,
        timeoutMs: 5000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 404);
      assert.match(error.message, /ollama pull qwen3-vl:4b/);
      return true;
    },
  );
});
