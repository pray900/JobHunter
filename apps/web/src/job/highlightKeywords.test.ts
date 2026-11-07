import { expect, test } from 'vitest';
import { highlightKeywords } from './highlightKeywords';

const hits = (text: string, kw: string[]) => highlightKeywords(text, kw).filter((s) => s.hit).map((s) => s.text);

test('whole word, case-insensitive', () => {
  expect(hits('Apex and apexes and APEX.', ['Apex'])).toEqual(['Apex', 'APEX']);
});

test('segments rebuild the original text', () => {
  const text = 'We need Apex, LWC and more.';
  expect(highlightKeywords(text, ['apex', 'lwc']).map((s) => s.text).join('')).toBe(text);
});

test('highlight treats optimise and optimize as the same', () => {
  expect(hits('We optimize and optimise things', ['optimise'])).toEqual(['optimize', 'optimise']);
  expect(hits('We optimize and optimise things', ['optimize'])).toEqual(['optimize', 'optimise']);
});

test('inflected variants and phrases', () => {
  expect(hits('He optimized the colour scheme', ['optimised', 'color'])).toEqual(['optimized', 'colour']);
  expect(hits('Use REST API calls', ['rest api'])).toEqual(['REST API']);
});

test('keywords with symbols and no keywords', () => {
  expect(hits('Knows C# and CI/CD (yes).', ['C#', 'CI/CD'])).toEqual(['C#', 'CI/CD']);
  expect(highlightKeywords('plain', [])).toEqual([{ text: 'plain', hit: false }]);
  expect(highlightKeywords('', ['x'])).toEqual([]);
});
