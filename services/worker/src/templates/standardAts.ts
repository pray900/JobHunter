import {
  AlignmentType,
  BorderStyle,
  Document,
  LevelFormat,
  Packer,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from 'docx';
import type { DocKind, TailoredCv, TailoredLetter } from '../generation/types.js';

// Standard ATS: A4, one column, no tables, no text boxes, one font. Bullets use Word numbering.
const FONT = 'Arial';
const PAGE = { width: 11906, height: 16838 }; // A4 in twips
const MARGIN = 1020; // about 1.8 cm
const TEXT_WIDTH = PAGE.width - 2 * MARGIN;
const BULLETS = 'bullets';

const half = (pt: number) => Math.round(pt * 2); // docx sizes are half-points

function run(text: string, size: number, opts: { bold?: boolean } = {}): TextRun {
  return new TextRun({ text, font: FONT, size: half(size), bold: opts.bold });
}

function body(text: string, size: number, spacingAfter = 80): Paragraph {
  return new Paragraph({ children: [run(text, size)], spacing: { after: spacingAfter } });
}

function bullet(text: string, size: number): Paragraph {
  return new Paragraph({
    children: [run(text, size)],
    numbering: { reference: BULLETS, level: 0 },
    spacing: { after: 40 },
  });
}

function heading(text: string): Paragraph {
  return new Paragraph({
    children: [run(text.toUpperCase(), 11.5, { bold: true })],
    keepNext: true,
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
  });
}

// Title on the left, dates pushed to the right margin by a right tab stop.
function titleLine(left: string, dates: string, size: number): Paragraph {
  const children = [run(left, size, { bold: true })];
  if (dates) children.push(new TextRun({ children: [new Tab()], font: FONT, size: half(size) }), run(dates, size));
  return new Paragraph({
    children,
    tabStops: [{ type: TabStopType.RIGHT, position: TEXT_WIDTH }],
    keepNext: true,
    spacing: { before: 80, after: 40 },
  });
}

const nameLine = (cv: TailoredCv): Paragraph =>
  new Paragraph({ children: [run(cv.name, 18, { bold: true })], spacing: { after: 40 } });

const contactLine = (cv: TailoredCv): string =>
  [cv.contact.location, cv.contact.email, cv.contact.phone, ...cv.contact.links.map((l) => `${l.label}: ${l.url}`)]
    .filter((p): p is string => !!p)
    .join(' | ');

// "Qualification, Institution", without a stray comma when either is empty.
export const educationLine = (e: TailoredCv['education'][number]): string =>
  [e.qualification, e.institution].filter((p) => p.trim() !== '').join(', ');

function cvParagraphs(cv: TailoredCv): Paragraph[] {
  const size = 10.5;
  const out: Paragraph[] = [nameLine(cv)];
  if (cv.headline) out.push(body(cv.headline, size, 40));
  const contact = contactLine(cv);
  if (contact) out.push(body(contact, size, 40));
  if (cv.workRights) out.push(body(cv.workRights, size, 40));

  if (cv.summary.trim() !== '') out.push(heading('Summary'), body(cv.summary, size));

  out.push(heading('Skills'));
  for (const g of cv.skills) out.push(body(`${g.group}: ${g.items.join(', ')}`, size, 40));

  out.push(heading('Experience'));
  for (const job of cv.experience) {
    out.push(titleLine([job.title, job.employer, job.location].filter(Boolean).join(', '), job.dates, size));
    for (const b of job.bullets) out.push(bullet(b, size));
  }

  if (cv.projects.length > 0) {
    out.push(heading('Projects'));
    for (const p of cv.projects) {
      out.push(new Paragraph({ children: [run(p.name, size, { bold: true })], keepNext: true, spacing: { before: 80, after: 40 } }));
      for (const b of p.bullets) out.push(bullet(b, size));
    }
  }

  out.push(heading('Education'));
  for (const e of cv.education) {
    out.push(titleLine(educationLine(e), e.dates, size));
    if (e.statusText) out.push(body(e.statusText, size, 40));
  }
  return out;
}

function letterParagraphs(cv: TailoredCv, letter: TailoredLetter): Paragraph[] {
  const size = 11;
  const out: Paragraph[] = [nameLine(cv)];
  const contact = contactLine(cv);
  if (contact) out.push(body(contact, size, 240));
  out.push(body(letter.date, size, 160));
  if (letter.addressee) out.push(body(letter.addressee, size, 160));
  out.push(body(letter.salutation, size, 160));
  for (const p of letter.paragraphs) out.push(body(p, size, 160));
  out.push(body(letter.signOff, size, 480), body(letter.name, size, 0));
  return out;
}

export async function renderStandardAts(kind: DocKind, cv: TailoredCv, letter?: TailoredLetter): Promise<Buffer> {
  if (kind === 'cover_letter' && !letter) throw new Error('cover letter data is required');
  const doc = new Document({
    creator: 'JobHunter',
    title: kind === 'cv' ? 'CV' : 'Cover letter',
    styles: { default: { document: { run: { font: FONT, size: half(10.5) } } } },
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 260 } }, run: { font: FONT } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: PAGE, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
        children: kind === 'cv' ? cvParagraphs(cv) : letterParagraphs(cv, letter!),
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
