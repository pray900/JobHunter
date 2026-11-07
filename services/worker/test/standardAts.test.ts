import JSZip from 'jszip';
import { expect, test } from 'vitest';
import { InvalidDocumentError, validateTailoredCv } from '../src/generation/validate.js';
import { readPdf } from '../src/render/pdf.js';
import { renderDocx } from '../src/templates/index.js';
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
