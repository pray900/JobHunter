import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { TailoredCv } from '../src/generation/types.js';
import { renderDocx } from '../src/templates/index.js';
import { LAYOUT_STEPS } from '../src/templates/layout.js';
import { renderStandardAts } from '../src/templates/standardAts.js';
import { CV, LETTER } from './fixtures.js';

const GOV: TailoredCv = {
  ...CV,
  competencies: ['Stakeholder engagement: led a 12-agency working group', 'Plain competency with no colon'],
  experience: [
    { ...CV.experience[0], bullets: ['Ran the thing'], achievements: ['Cut costs by 20%'] },
    { ...CV.experience[0], title: 'Second role', bullets: ['Did stuff'], achievements: [] },
  ],
};

const unzip = async (docx: Buffer) => JSZip.loadAsync(docx);
const docXml = async (docx: Buffer) => (await unzip(docx)).file('word/document.xml')!.async('string');
const paras = (xml: string) => xml.split('</w:p>');
const text = (p: string) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
const render = (cv: TailoredCv = GOV) => renderDocx('au-government', 'cv', cv);

test('headings appear in order, upper case, with navy colour and a bottom border', async () => {
  const xml = await docXml(await render());
  const texts = paras(xml).map(text);
  const order = ['PROFESSIONAL SUMMARY', 'KEY SKILLS & COMPETENCIES', 'PROFESSIONAL EXPERIENCE', 'PROJECTS', 'QUALIFICATIONS'];
  const idx = order.map((h) => texts.indexOf(h.replace('&', '&amp;')));
  for (const i of idx) expect(i).toBeGreaterThanOrEqual(0);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  for (const h of order) {
    const p = paras(xml).find((q) => text(q) === h.replace('&', '&amp;'))!;
    expect(p).toContain('<w:pBdr>');
    expect(p).toContain('w:val="1F3864"');
  }
  const name = paras(xml).find((q) => text(q) === CV.name)!;
  expect(name).toContain('w:val="1F3864"');
});

test('summary and projects headings are omitted when empty', async () => {
  const xml = await docXml(await render({ ...GOV, summary: '', projects: [] }));
  expect(xml).not.toContain('PROFESSIONAL SUMMARY');
  expect(xml).not.toContain('>PROJECTS<');
});

test('competencies are one paragraph each with the capability in bold, then skill groups', async () => {
  const xml = await docXml(await render());
  const ps = paras(xml);
  const c = ps.find((p) => text(p).startsWith('Stakeholder engagement: '))!;
  expect(text(c)).toBe('Stakeholder engagement: led a 12-agency working group');
  const runs = c.split('<w:r>').filter((r) => r.includes('<w:t'));
  expect(runs[0]).toContain('<w:b/>');
  expect(runs[0]).toContain('>Stakeholder engagement<');
  expect(runs.slice(1).join('')).not.toContain('<w:b/>');
  const plain = ps.find((p) => text(p) === 'Plain competency with no colon')!;
  expect(plain).not.toContain('<w:b/>');
  const texts = ps.map(text);
  const skillIdx = texts.findIndex((t) => t.startsWith(`${CV.skills[0].group}: `));
  expect(skillIdx).toBeGreaterThan(texts.indexOf('Plain competency with no colon'));
});

test('role order: title, Responsibilities, bullets, Key Achievements, achievements', async () => {
  const xml = await docXml(await render());
  const texts = paras(xml).map(text);
  const i = texts.findIndex((t) => t.includes(GOV.experience[0].title));
  expect(texts.slice(i + 1, i + 5)).toEqual(['Responsibilities', 'Ran the thing', 'Key Achievements', 'Cut costs by 20%']);
  const j = texts.findIndex((t) => t.includes('Second role'));
  expect(texts.slice(j + 1, j + 3)).toEqual(['Responsibilities', 'Did stuff']);
  expect(texts.slice(j + 3, j + 4)).not.toContain('Key Achievements');
});

test('an old CV with no achievements key renders', async () => {
  const xml = await docXml(await render(CV));
  expect(xml).toContain('Responsibilities');
  expect(xml).not.toContain('Key Achievements');
});

test('there is no referees section', async () => {
  const texts = paras(await docXml(await render())).map(text);
  expect(texts).not.toContain('REFEREES');
  expect(texts.join(' ')).not.toMatch(/referees/i);
});

test('CV footer has Page N of M fields; the letter has none', async () => {
  const zip = await unzip(await render());
  const names = Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n));
  expect(names.length).toBe(1);
  const f = await zip.file(names[0])!.async('string');
  expect(f).toContain('PAGE');
  expect(f).toContain('NUMPAGES');
  expect(f).toContain('Page ');
  expect(f).toContain(' of ');
  const letter = await unzip(await renderDocx('au-government', 'cover_letter', GOV, LETTER));
  expect(Object.keys(letter.files).filter((n) => n.includes('footer') && n.endsWith('.xml'))).toEqual([]);
});

test('the contact line matches Standard ATS', async () => {
  const contact = (xml: string) => paras(xml).map(text).find((t) => t.includes(CV.contact.email!))!;
  expect(contact(await docXml(await render()))).toBe(contact(await docXml(await renderStandardAts('cv', GOV))));
});

test('the deepest layout step gives 9.5 pt body and 720 margins', async () => {
  const xml = await docXml(await renderDocx('au-government', 'cv', GOV, undefined, LAYOUT_STEPS[5]));
  expect(LAYOUT_STEPS[5].bodyPt).toBe(9.5);
  expect(xml).toContain('<w:sz w:val="19"/>');
  expect(xml).toContain('w:left="720"');
});

test('Standard ATS output is unchanged', async () => {
  const xml = await docXml(await renderStandardAts('cv', CV));
  expect(createHash('sha256').update(xml).digest('hex')).toBe('ae22a54412d5788679a7683cc485224aa1210164836936917af8ce47db09ade2');
});
