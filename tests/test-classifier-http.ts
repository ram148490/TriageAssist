import assert from 'assert';
import http from 'http';
import { GoogleGenAI } from '@google/genai';

// Same fail-safe guarantees as test-classifier.ts, but through the REAL Gemini SDK
// over real HTTP against a local server that misbehaves on purpose. Needs no API
// key, database or network.
delete process.env.GEMINI_API_KEY;

const { classifySymptoms } = await import('../server/lib/classifier');
const { FALLBACK_MODEL_NAME } = await import('../shared/types');

const TIMEOUT_MS = 1500;
const goodPayload = { urgencyLevel: 'low', suggestedDepartment: 'Minor Illness', confidenceScore: 0.9 };
const geminiBody = (text: string) =>
  JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });

type Behavior = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const modes: Record<string, { behavior: Behavior; expectFailSafe: boolean }> = {
  'valid response': {
    expectFailSafe: false,
    behavior: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(geminiBody(JSON.stringify(goodPayload)));
    },
  },
  'valid but slow (within the deadline)': {
    expectFailSafe: false,
    behavior: (_req, res) =>
      void setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(geminiBody(JSON.stringify(goodPayload)));
      }, 300),
  },
  'accepts the request and never answers (hang)': { expectFailSafe: true, behavior: () => {} },
  'sends headers, then stalls mid-body': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"candidates":[{"content":');
    },
  },
  'HTTP 429 quota exceeded': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"code":429,"message":"You exceeded your current quota"}}');
    },
  },
  'HTTP 503 model overloaded': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}');
    },
  },
  'HTTP 500 with an HTML body': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html><body>Internal Server Error</body></html>');
    },
  },
  'HTTP 200 with a non-JSON body': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>captive portal login</html>');
    },
  },
  'HTTP 200 whose model text is not the requested JSON': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(geminiBody('I am unable to classify this.'));
    },
  },
  'HTTP 200 whose model text has an invalid enum value': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(geminiBody(JSON.stringify({ ...goodPayload, urgencyLevel: 'critical' })));
    },
  },
  'HTTP 200 with no candidates (e.g. safety block)': {
    expectFailSafe: true,
    behavior: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }));
    },
  },
  'connection dropped without a response': { expectFailSafe: true, behavior: (req) => void req.socket.destroy() },
};

const unhandled: unknown[] = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const originalError = console.error;
console.error = () => {}; // the classifier logs each expected failure; keep test output readable

for (const [label, { behavior, expectFailSafe }] of Object.entries(modes)) {
  const server = http.createServer((req, res) => {
    req.resume();
    behavior(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const client = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: `http://127.0.0.1:${port}` } });

  const started = Date.now();
  const result = await classifySymptoms('chest pain and trouble breathing', client, TIMEOUT_MS);
  const elapsed = Date.now() - started;

  if (expectFailSafe) {
    assert.strictEqual(result.urgencyLevel, 'high', `${label}: urgency`);
    assert.strictEqual(result.confidenceScore, 0, `${label}: confidence`);
    assert.strictEqual(result.modelName, FALLBACK_MODEL_NAME, `${label}: modelName`);
  } else {
    assert.notStrictEqual(result.modelName, FALLBACK_MODEL_NAME, `${label}: should not have fallen back`);
    assert.strictEqual(result.urgencyLevel, 'low', `${label}: urgency`);
    assert.strictEqual(result.confidenceScore, 0.9, `${label}: confidence`);
  }
  // Whatever happens, the caller gets an answer within the deadline (plus scheduling slack).
  assert.ok(elapsed < TIMEOUT_MS + 1000, `${label}: took ${elapsed}ms, deadline is ${TIMEOUT_MS}ms`);

  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  originalError(`  ok  ${label} (${elapsed}ms)`);
}

console.error = originalError;
await new Promise((r) => setTimeout(r, 300));
assert.deepStrictEqual(unhandled, [], 'no unhandled rejections may escape');

console.log('test-classifier-http: all assertions passed.');
