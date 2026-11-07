import { AU_SPELLING_PAIRS } from './auSpelling';

export interface Segment {
  text: string;
  hit: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every spelling a word may appear in: the pair plus simple inflections (s, d/ed, ing, r).
function forms(word: string): string[] {
  const stem = word.endsWith('e') ? word.slice(0, -1) : word;
  return [word, `${word}s`, word.endsWith('e') ? `${word}d` : `${word}ed`, `${stem}ing`, word.endsWith('e') ? `${word}r` : `${word}er`];
}

// lower-case any form -> all spellings (US and AU) of the same word
const VARIANTS = new Map<string, string[]>();
for (const [us, au] of AU_SPELLING_PAIRS) {
  const usForms = forms(us);
  const auForms = forms(au);
  usForms.forEach((u, i) => {
    const group = [u, auForms[i]!];
    for (const f of group) VARIANTS.set(f, [...new Set([...(VARIANTS.get(f) ?? []), ...group])]);
  });
}

function wordPattern(word: string): string {
  const lower = word.toLowerCase();
  const alts = VARIANTS.get(lower) ?? [lower];
  return alts.length > 1 ? `(?:${alts.map(escape).join('|')})` : escape(word);
}

function keywordPattern(keyword: string): string {
  return keyword
    .trim()
    .split(/\s+/)
    .map((w) => (/^[A-Za-z]+$/.test(w) ? wordPattern(w) : escape(w)))
    .join('\\s+');
}

// Splits text into plain and highlighted runs. Case-insensitive, whole word, US/AU variants equal.
export function highlightKeywords(text: string, keywords: string[]): Segment[] {
  if (!text) return [];
  const pats = keywords.filter((k) => k.trim()).map(keywordPattern);
  if (pats.length === 0) return [{ text, hit: false }];
  // Longest first so "REST API" wins over "REST".
  pats.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${pats.join('|')})(?![A-Za-z0-9])`, 'gi');
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m[0] === '') continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}
