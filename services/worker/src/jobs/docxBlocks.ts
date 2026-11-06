import type { HTMLElement } from 'node-html-parser';
import mammoth from 'mammoth';
import { parse, TextNode, type Node } from 'node-html-parser';

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li';

export interface DocxBlock {
  text: string;
  href: string | undefined;
}

// Own text of a block: <br> becomes a newline, nested lists are left to their own li.
function ownText(node: Node): string {
  if (node instanceof TextNode) return node.text;
  const el = node as HTMLElement;
  const tag = el.tagName?.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'ul' || tag === 'ol') return '';
  return el.childNodes.map(ownText).join('');
}

// Non-empty text blocks of a DOCX, in order. Throws if mammoth cannot read the bytes.
export async function readDocxBlocks(bytes: Buffer): Promise<DocxBlock[]> {
  const html = (await mammoth.convertToHtml({ buffer: bytes })).value;
  return parse(html)
    .querySelectorAll(BLOCK_SELECTOR)
    .map((el) => ({ text: ownText(el).trim(), href: el.querySelector('a[href]')?.getAttribute('href') }))
    .filter((b) => b.text !== '');
}
