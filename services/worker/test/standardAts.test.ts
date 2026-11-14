import JSZip from 'jszip';
import { expect, test } from 'vitest';
import { InvalidDocumentError, validateTailoredCv } from '../src/generation/validate.js';
import { readPdf } from '../src/render/pdf.js';
import { renderDocx } from '../src/templates/index.js';
import { LAYOUT_STEPS, shortLink } from '../src/templates/layout.js';
import { CV, LETTER, makePdf } from './fixtures.js';

const documentXml = async (docx: Buffer) => (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');

test('docx has no tables, one font, numbered bullets', async () => {
  const xml = await documentXml(await renderDocx('standard-ats', 'cv', CV));
  expect(xml).not.toContain('<w:tbl');
  expect(xml).not.toContain('txbxContent');
  expect(xml).not.toContain('<w:cols');
  const fonts = [...xml.matchAll(/<w:rFonts [^>]*>/g)].map((m) => m[0]);
  expect(fonts.length).toBeGreaterThan(0);
  for (const f of fonts) expect(f).toContain('w:ascii="Arial"');
  expect(xml).toContain('<w:numPr>');
  expect(xml).not.toContain('•');
  // Section headings: uppercase, keep with next, bottom border.
  for (const h of ['SUMMARY', 'SKILLS', 'EXPERIENCE', 'PROJECTS', 'EDUCATION']) {
    const para = xml.split('</w:p>').find((p) => p.includes(`>${h}<`));
    expect(para, h).toBeDefined();
    expect(para).toContain('<w:keepNext/>');
    expect(para).toContain('<w:pBdr>');
  }
  expect(xml).toContain('<w:sz w:val="36"/>'); // name 18 pt
  expect(xml).toContain('<w:sz w:val="21"/>'); // body 10.5 pt
});

test('dates sit on a right tab stop', async () => {
  const xml = await documentXml(await renderDocx('standard-ats', 'cv', CV));
  const para = xml.split('</w:p>').find((p) => p.includes('Jan 2022 - Present'))!;
  expect(para).toMatch(/<w:tab w:val="right" w:pos="\d+"\/>/);
  expect(para).toContain('<w:tab/>');
});

test('projects are omitted when empty and work rights only when present', async () => {
  const xml = await documentXml(await renderDocx('standard-ats', 'cv', { ...CV, projects: [], workRights: null }));
  expect(xml).not.toContain('PROJECTS');
  expect(xml).not.toContain('Australian citizen');
});

test('cover letter uses 11 pt and the CV contact block', async () => {
  const xml = await documentXml(await renderDocx('standard-ats', 'cover_letter', CV, LETTER));
  expect(xml).toContain('<w:sz w:val="22"/>');
  expect(xml).toContain('jordan@example.com');
  expect(xml).toContain('Dear Hiring Manager,');
  expect(xml).not.toContain('<w:tbl');
});

test('validate rejects a missing name and names the path', () => {
  const { name: _name, ...rest } = CV;
  try {
    validateTailoredCv(rest);
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidDocumentError);
    expect((err as InvalidDocumentError).path).toBe('cv.name');
  }
  expect(() => validateTailoredCv({ ...CV, experience: [{ ...CV.experience[0], bullets: [1] }] })).toThrow(
    /experience\[0\]\.bullets\[0\]/,
  );
});

test('readPdf counts pages', async () => {
  expect((await readPdf(makePdf(2))).pages).toBe(2);
});

test('I2: an education entry without an institution or qualification is valid and has no stray comma', async () => {
  const cv = {
    ...CV,
    education: [
      { qualification: 'Salesforce Certified Platform Developer I', institution: '', dates: '2023', statusText: '' },
      { qualification: '', institution: 'Example Institute', dates: '2019', statusText: '' },
    ],
  };
  expect(validateTailoredCv(cv).education[0].institution).toBe('');
  const xml = await documentXml(await renderDocx('standard-ats', 'cv', cv));
  expect(xml).toContain('>Salesforce Certified Platform Developer I<');
  expect(xml).not.toContain('Developer I, ');
  expect(xml).toContain('>Example Institute<');
  expect(xml).not.toMatch(/>, Example Institute/);
  // Other fields the template needs stay required.
  expect(() => validateTailoredCv({ ...CV, experience: [{ ...CV.experience[0], employer: '' }] })).toThrow(/experience\[0\]\.employer/);
});

test('M11: an empty summary has no SUMMARY heading', async () => {
  const xml = await documentXml(await renderDocx('standard-ats', 'cv', { ...CV, summary: '  ' }));
  expect(xml).not.toContain('SUMMARY');
  expect(xml).toContain('SKILLS');
});

const paraTexts = (xml: string) =>
  xml
    .split('</w:p>')
    .map((p) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(''))
    .filter((t) => t !== '');

const FULL = {
  ...CV,
  headline: 'Engineer',
  contact: {
    location: 'Sydney, NSW',
    email: 'a@b.com',
    phone: '0400 000 000',
    links: [
      { label: 'LinkedIn', url: 'https://www.linkedin.com/in/x/' },
      { label: 'GitHub', url: 'http://github.com/y' },
    ],
  },
  workRights: 'Full work rights in Australia',
};

test('shortLink strips scheme, www and one trailing slash', () => {
  expect(shortLink('https://www.linkedin.com/in/x/')).toBe('linkedin.com/in/x');
  expect(shortLink('HTTP://github.com/pray900')).toBe('github.com/pray900');
  expect(shortLink('pray900.github.io/P')).toBe('pray900.github.io/P');
});

test('CV header is name, headline, one compact contact line', async () => {
  const xml = await documentXml(await renderDocx('standard-ats', 'cv', FULL));
  const texts = paraTexts(xml);
  expect(texts.slice(0, 3)).toEqual([
    'Jordan Testcase',
    'Engineer',
    'Sydney, NSW | a@b.com | 0400 000 000 | linkedin.com/in/x | github.com/y | Full work rights in Australia',
  ]);
  expect(texts[3]).toBe('SUMMARY');
  expect(xml).not.toContain('LinkedIn:');
  expect(xml).not.toContain('https://');
});

test('contact line drops empties', async () => {
  const bare = { ...FULL, contact: { location: 'Sydney', email: '', phone: '', links: [] }, workRights: null };
  const texts = paraTexts(await documentXml(await renderDocx('standard-ats', 'cv', bare)));
  expect(texts.slice(0, 3)).toEqual(['Jordan Testcase', 'Engineer', 'Sydney']);
  const none = { ...bare, contact: { location: '', email: '', phone: '', links: [] } };
  const texts2 = paraTexts(await documentXml(await renderDocx('standard-ats', 'cv', none)));
  expect(texts2.slice(0, 3)).toEqual(['Jordan Testcase', 'Engineer', 'SUMMARY']);
});

test('letter contact uses short links and no work rights', async () => {
  const texts = paraTexts(await documentXml(await renderDocx('standard-ats', 'cover_letter', FULL, LETTER)));
  expect(texts[1]).toBe('Sydney, NSW | a@b.com | 0400 000 000 | linkedin.com/in/x | github.com/y');
  expect(texts.join('\n')).not.toContain('work rights');
});

test('layout parameter changes size, margins and spacing; default is today', async () => {
  const dflt = await documentXml(await renderDocx('standard-ats', 'cv', FULL));
  const tight = await documentXml(await renderDocx('standard-ats', 'cv', FULL, undefined, LAYOUT_STEPS[5]));
  expect(dflt).toContain('<w:sz w:val="21"/>');
  expect(dflt).toContain('w:left="1020"');
  expect(tight).toContain('<w:sz w:val="19"/>');
  expect(tight).toContain('w:left="720"');
  const before = (xml: string) =>
    Number(xml.split('</w:p>').find((p) => p.includes('>SKILLS<'))!.match(/w:before="(\d+)"/)![1]);
  expect(before(tight)).toBeLessThan(before(dflt));
  const bulletAfter = (xml: string) =>
    Number(xml.split('</w:p>').find((p) => p.includes('Built an invoicing service.'))!.match(/w:after="(\d+)"/)![1]);
  expect(bulletAfter(tight)).toBeLessThan(bulletAfter(dflt));
});
