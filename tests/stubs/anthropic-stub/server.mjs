// Minimal Anthropic Messages API stub for e2e tests.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const CANNED = {
  title: 'Stub Title',
  employer: 'Stub Employer',
  advertiser: null,
  short_description: 'Stub description.',
};
let requests = [];

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const err = (res, status, message) =>
  send(res, status, { type: 'error', error: { type: 'invalid_request_error', message } });

const userText = (body) =>
  (body?.messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join('\n')))
    .join('\n');

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/_requests') return send(res, 200, requests);
    if (req.method === 'POST' && url === '/_reset') {
      requests = [];
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url === '/v1/messages') {
      if (!req.headers['x-api-key']) return err(res, 400, 'x-api-key header required');
      if (req.headers['anthropic-version'] !== '2026-10-21')
        return err(res, 400, 'anthropic-version must be 2026-10-21');
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return err(res, 400, 'invalid JSON');
      }
      requests.push(body);
      const text = userText(body);
      if (text.includes('STUB_FAIL')) return send(res, 500, { type: 'error', error: { type: 'api_error', message: 'stub failure' } });
      const base = { id: 'msg_stub', type: 'message', role: 'assistant', model: body.model ?? 'stub' };
      if (text.includes('STUB_REFUSE'))
        return send(res, 200, { ...base, content: [], stop_reason: 'refusal', usage: { input_tokens: 1000, output_tokens: 100 } });
      return send(res, 200, {
        ...base,
        content: [{ type: 'text', text: JSON.stringify(CANNED) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    }
    err(res, 404, 'not found');
  });
}).listen(PORT, () => console.log(`anthropic-stub listening on ${PORT}`));
