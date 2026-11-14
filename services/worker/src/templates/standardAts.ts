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
import { LAYOUT_STEPS, shortLink, type CvLayout } from './layout.js';
import type { DocKind, TailoredCv, TailoredLetter } from '../generation/types.js';

// Standard ATS: A4, one column, no tables, no text boxes, one font. Bullets use Word numbering.
const FONT = 'Arial';
const PAGE = { width: 11906, height: 16838 }; // A4 in twips
const MARGIN = 1020; // about 1.8 cm
const BULLETS = 'bullets';

const half = (pt: number) => Math.round(pt * 2); // docx sizes are half-points
const toHalfPt = (pt: number) => Math.round(pt * 2) / 2;

function run(text: string, size: number, opts: { bold?: boolean } = {}): TextRun {
  return new TextRun({ text, font: FONT, size: half(size), bold: opts.bold });
}

function body(text: string, size: number, spacingAfter = 80, k = 1): Paragraph {
  return new Paragraph({ children: [run(text, size)], spacing: { after: Math.round(spacingAfter * k) } });
}

function bullet(text: string, size: number, k = 1): Paragraph {
  return new Paragraph({
    children: [run(text, size)],
    numbering: { reference: BULLETS, level: 0 },
    spacing: { after: Math.round(40 * k) },
  });
}

function heading(text: string, size: number, k: number): Paragraph {
  return new Paragraph({
    children: [run(text.toUpperCase(), size, { bold: true })],
    keepNext: true,
    spacing: { before: Math.round(200 * k), after: Math.round(80 * k) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
  });
}

// Title on the left, dates pushed to the right margin by a right tab stop.
function titleLine(left: string, dates: string, size: number, textWidth: number, k: number): Paragraph {
  const children = [run(left, size, { bold: true })];
  if (dates) children.push(new TextRun({ children: [new Tab()], font: FONT, size: half(size) }), run(dates, size));
  return new Paragraph({
    children,
    tabStops: [{ type: TabStopType.RIGHT, position: textWidth }],
    keepNext: true,
    spacing: { before: Math.round(80 * k), after: Math.round(40 * k) },
  });
}

const nameLine = (cv: TailoredCv, size = 18, k = 1): Paragraph =>
  new Paragraph({ children: [run(cv.name, size, { bold: true })], spacing: { after: Math.round(40 * k) } });

const contactLine = (cv: TailoredCv, withWorkRights: boolean): string =>
  [
    cv.contact.location,
    cv.contact.email,
    cv.contact.phone,
    ...cv.contact.links.map((l) => shortLink(l.url)),
    withWorkRights ? cv.workRights : null,
  ]
    .filter((p): p is string => !!p)
    .join(' | ');

// "Qualification, Institution", without a stray comma when either is empty.
export const educationLine = (e: TailoredCv['education'][number]): string =>
  [e.qualification, e.institution].filter((p) => p.trim() !== '').join(', ');

function cvParagraphs(cv: TailoredCv, layout: CvLayout): Paragraph[] {
  const size = layout.bodyPt;
  const k = layout.spacing;
  const textWidth = PAGE.width - 2 * layout.marginTwips;
  const headSize = toHalfPt((11.5 * size) / 10.5);
  const out: Paragraph[] = [nameLine(cv, toHalfPt((18 * size) / 10.5), k)];
  if (cv.headline) out.push(body(cv.headline, size, 40, k));
  const contact = contactLine(cv, true);
  if (contact) out.push(body(contact, size, 40, k));

  if (cv.summary.trim() !== '') out.push(heading('Summary', headSize, k), body(cv.summary, size, 80, k));

  out.push(heading('Skills', headSize, k));
  for (const g of cv.skills) out.push(body(`${g.group}: ${g.items.join(', ')}`, size, 40, k));

  out.push(heading('Experience', headSize, k));
  for (const job of cv.experience) {
    out.push(titleLine([job.title, job.employer, job.location].filter(Boolean).join(', '), job.dates, size, textWidth, k));
    for (const b of job.bullets) out.push(bullet(b, size, k));
  }

  if (cv.projects.length > 0) {
    out.push(heading('Projects', headSize, k));
    for (const p of cv.projects) {
      out.push(
        new Paragraph({
          children: [run(p.name, size, { bold: true })],
          keepNext: true,
          spacing: { before: Math.round(80 * k), after: Math.round(40 * k) },
        }),
      );
      for (const b of p.bullets) out.push(bullet(b, size, k));
    }
  }

  out.push(heading('Education', headSize, k));
  for (const e of cv.education) {
    out.push(titleLine(educationLine(e), e.dates, size, textWidth, k));
    if (e.statusText) out.push(body(e.statusText, size, 40, k));
  }
  return out;
}

function letterParagraphs(cv: TailoredCv, letter: TailoredLetter): Paragraph[] {
  const size = 11;
  const out: Paragraph[] = [nameLine(cv)];
  const contact = contactLine(cv, false);
  if (contact) out.push(body(contact, size, 240));
  out.push(body(letter.date, size, 160));
  if (letter.addressee) out.push(body(letter.addressee, size, 160));
  out.push(body(letter.salutation, size, 160));
  for (const p of letter.paragraphs) out.push(body(p, size, 160));
  out.push(body(letter.signOff, size, 480), body(letter.name, size, 0));
  return out;
}

export async function renderStandardAts(
  kind: DocKind,
  cv: TailoredCv,
  letter?: TailoredLetter,
  layout: CvLayout = LAYOUT_STEPS[0],
): Promise<Buffer> {
  if (kind === 'cover_letter' && !letter) throw new Error('cover letter data is required');
  const isCv = kind === 'cv';
  const margin = isCv ? layout.marginTwips : MARGIN;
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
        properties: { page: { size: PAGE, margin: { top: margin, bottom: margin, left: margin, right: margin } } },
        children: isCv ? cvParagraphs(cv, layout) : letterParagraphs(cv, letter!),
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
