import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { STUB_URL, stub } from './lib';

// The fake Anthropic server answers by the purpose on the first line of the system prompt.
async function ask(purpose: string): Promise<any> {
  const res = await fetch(`${STUB_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', system: `purpose: ${purpose}\nrest`, messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  return JSON.parse(body.content[0].text);
}

describe('anthropic stub', () => {
  beforeEach(() => stub.reset());
  afterAll(() => stub.reset());

  test('scripted answers come in order then canned', async () => {
    const canned = await ask('review_documents');
    expect(canned.verdict).toBe('pass');
    await stub.scriptPurpose('review_documents', [{ verdict: 'fail', n: 1 }, { verdict: 'fail', n: 2 }]);
    expect((await ask('review_documents')).n).toBe(1);
    expect((await ask('review_documents')).n).toBe(2);
    expect(await ask('review_documents')).toEqual(canned);
    // Other purposes are untouched, and reset clears a script.
    await stub.scriptPurpose('review_documents', [{ n: 9 }]);
    expect((await ask('write_documents')).cv.name).toBe('Stub Person');
    await stub.reset();
    expect(await ask('review_documents')).toEqual(canned);
  });

  test('a scripted __stub_status answers that HTTP error once', async () => {
    await stub.scriptPurpose('write_documents', [{ __stub_status: 529 }]);
    const call = () =>
      fetch(`${STUB_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'k', 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', system: 'purpose: write_documents', messages: [{ role: 'user', content: 'hi' }] }),
      });
    expect((await call()).status).toBe(529);
    expect((await call()).status).toBe(200);
  });

  test('canned reviewer passes every checklist item', async () => {
    const r = await ask('review_documents');
    expect(r.items).toHaveLength(14);
    expect(r.items.every((i: any) => i.pass === true)).toBe(true);
  });
});
