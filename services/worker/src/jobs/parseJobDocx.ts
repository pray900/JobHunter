import { readDocxBlocks, type DocxBlock } from './docxBlocks.js';
import type { ParsedJob, WarningCode } from './types.js';

const URL_IN_TEXT = /https?:\/\/\S+/;
const isHttp = (s: string | undefined): s is string => !!s && /^https?:\/\//i.test(s);

export async function parseJobDocx(bytes: Buffer): Promise<ParsedJob> {
  let blocks: DocxBlock[];
  try {
    blocks = await readDocxBlocks(bytes);
  } catch {
    return { url: null, body: '', warnings: ['unreadable_file'] };
  }

  const first = blocks[0];
  const url = first ? (isHttp(first.href) ? first.href : (first.text.match(URL_IN_TEXT)?.[0] ?? null)) : null;

  const warnings: WarningCode[] = [];
  // Anything after the URL line inside the first block (soft line breaks) stays in the body.
  const rest = url && first ? first.text.split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
  const bodyBlocks = url ? [...rest.map((text) => ({ text })), ...blocks.slice(1)] : blocks;
  if (!url) warnings.push('missing_url');
  const body = bodyBlocks.map((b) => b.text).join('\n').trim();
  if (body === '') warnings.push('empty_description');
  return { url, body, warnings };
}
