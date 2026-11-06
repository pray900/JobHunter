import type { HTMLElement } from 'node-html-parser';
import mammoth from 'mammoth';
import { parse, TextNode, type Node } from 'node-html-parser';
import type { ParsedJob, WarningCode } from './types.js';

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li';
const URL_IN_TEXT = /https?:\/\/\S+/;
// Own text of a block: <br> becomes a newline, nested lists are left to their own li.
function ownText(node: Node): string {
  if (node instanceof TextNode) return node.text;
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'ul' || tag === 'ol') return '';
  return el.childNodes.map(ownText).join('');
}
const isHttp = (s: string | undefined): s is string => !!s && /^https?:\/\//i.test(s);

export async function parseJobDocx(bytes: Buffer): Promise<ParsedJob> {
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: bytes })).value;
  } catch {
    return { url: null, body: '', warnings: ['unreadable_file'] };
  }

  const blocks = parse(html)
    .querySelectorAll(BLOCK_SELECTOR)
    .map((el) => ({ text: ownText(el).trim(), href: el.querySelector('a[href]')?.getAttribute('href') }))
    .filter((b) => b.text !== '');

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
