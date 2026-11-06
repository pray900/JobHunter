import { expect, test } from 'vitest';
import { parseJobDocx } from '../src/jobs/parseJobDocx.js';
import { makeDocx } from '../../../tests/helpers/makeDocx.js';

test('URL on first line, rest is body', async () => {
  const r = await parseJobDocx(await makeDocx([{ text: 'https://au.seek.com/job/1' }, { text: 'Salesforce Developer' }, { text: 'Apex & LWC' }]));
  expect(r).toEqual({ url: 'https://au.seek.com/job/1', body: 'Salesforce Developer\nApex & LWC', warnings: [] });
});
test('skips leading empty paragraphs', async () => {
  const r = await parseJobDocx(await makeDocx([{ empty: true }, { text: 'https://x.io/a?b=1&c=2' }, { text: 'Body' }]));
  expect(r.url).toBe('https://x.io/a?b=1&c=2');
});
test('reads URL from a Word HYPERLINK field', async () => {
  const url = 'https://www.linkedin.com/jobs/search-results/?currentJobId=1&keywords=salesforce';
  const r = await parseJobDocx(await makeDocx([{ hyperlinkField: { url, display: url } }, { text: 'Body' }]));
  expect(r.url).toBe(url);
});
test('reads URL from a hyperlink whose display text differs', async () => {
  const r = await parseJobDocx(await makeDocx([{ hyperlink: { url: 'https://x.io/j', display: 'Apply here' } }, { text: 'Body' }]));
  expect(r.url).toBe('https://x.io/j');
});
test('no URL on first line → missing_url, whole text is body', async () => {
  const r = await parseJobDocx(await makeDocx([{ text: 'Salesforce Developer' }, { text: 'Body' }]));
  expect(r).toEqual({ url: null, body: 'Salesforce Developer\nBody', warnings: ['missing_url'] });
});
test('URL only → empty_description', async () => {
  expect((await parseJobDocx(await makeDocx([{ text: 'https://x.io' }]))).warnings).toEqual(['empty_description']);
});
test('corrupt file returns unreadable warning', async () => {
  expect(await parseJobDocx(Buffer.from('not a zip'))).toEqual({ url: null, body: '', warnings: ['unreadable_file'] });
});
