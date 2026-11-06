import type { BaseCoverLetterFacts, BaseCvFacts, DocWarning } from './types.js';

// One phrase per line; blank lines and '#' comments are ignored.
export function parseBannedPhrases(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const OPEN_END = /[-–—]\s*$/;
const STILL_RUNNING = /\b(present|current|currently|ongoing)\b/i;
const CONFERRAL = /\bconferr(al|ed)\b/i;

// Every string anywhere in the facts, so new text fields are checked without changes here.
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word-boundary, case-insensitive match. The phrase's single spaces match literal spaces in the text.
function phraseRegex(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(phrase)}(?![\\p{L}\\p{N}])`, 'iu');
}

function bannedPhraseWarnings(facts: unknown, bannedPhrases: string[]): DocWarning[] {
  const texts = collectStrings(facts);
  const warnings: DocWarning[] = [];
  const seen = new Set<string>();
  for (const phrase of bannedPhrases) {
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    const re = phraseRegex(phrase);
    if (texts.some((t) => re.test(t))) {
      seen.add(key);
      warnings.push({ code: 'banned_phrase', detail: phrase });
    }
  }
  return warnings;
}

export function checkBaseCv(facts: BaseCvFacts, bannedPhrases: string[]): DocWarning[] {
  const warnings: DocWarning[] = [];
  if (!facts.workRights || facts.workRights.trim() === '') {
    warnings.push({ code: 'missing_work_rights', detail: 'No work-rights line found.' });
  }
  for (const entry of facts.education ?? []) {
    const dates = entry.dates ?? '';
    const status = entry.statusText ?? '';
    const open = STILL_RUNNING.test(dates) || STILL_RUNNING.test(status) || OPEN_END.test(dates.trim());
    if (open && !CONFERRAL.test(`${dates} ${status}`)) {
      warnings.push({
        code: 'degree_status_unclear',
        detail: `${entry.qualification}: "${dates}" does not say whether the degree is complete.`,
      });
    }
  }
  return [...warnings, ...bannedPhraseWarnings(facts, bannedPhrases)];
}

export function checkBaseCoverLetter(facts: BaseCoverLetterFacts, bannedPhrases: string[]): DocWarning[] {
  return bannedPhraseWarnings(facts, bannedPhrases);
}
