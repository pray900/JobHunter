import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from 'docx';
import { LAYOUT_STEPS, type CvLayout } from './layout.js';
import type { DocKind, TailoredCv, TailoredLetter } from '../generation/types.js';
import {
  BULLETS,
  FONT,
  PAGE,
  body,
  bullet,
  contactLine,
  educationLine,
  half,
  renderStandardAts,
  run,
  titleLine,
  toHalfPt,
} from './standardAts.js';

// Australian Government CV: same building blocks as Standard ATS (A4, one column, no tables,
// Word bullets, right tab for dates), with navy headings and a "Page N of M" footer.
const NAVY = '1F3864';
const GREY = '666666';

function heading(text: string, size: number, k: number): Paragraph {
  return new Paragraph({
    children: [run(text.toUpperCase(), size, { bold: true, color: NAVY })],
    keepNext: true,
    spacing: { before: Math.round(200 * k), after: Math.round(80 * k) },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 1 } },
  });
}

function label(text: string, size: number, k: number): Paragraph {
  return new Paragraph({
    children: [run(text, size, { bold: true })],
    keepNext: true,
    spacing: { before: Math.round(40 * k), after: Math.round(20 * k) },
  });
}

// "Capability: proof": the text before the first ": " in bold, the rest plain.
function competency(text: string, size: number, k: number): Paragraph {
  const at = text.indexOf(': ');
  const children =
    at < 0 ? [run(text, size)] : [run(text.slice(0, at), size, { bold: true }), run(`: ${text.slice(at + 2)}`, size)];
  return new Paragraph({ children, spacing: { after: Math.round(40 * k) } });
}

function cvParagraphs(cv: TailoredCv, layout: CvLayout): Paragraph[] {
  const size = layout.bodyPt;
  const k = layout.spacing;
  const textWidth = PAGE.width - 2 * layout.marginTwips;
  const headSize = toHalfPt((11.5 * size) / 10.5);
  const out: Paragraph[] = [
    new Paragraph({
      children: [run(cv.name, toHalfPt((18 * size) / 10.5), { bold: true, color: NAVY })],
      spacing: { after: Math.round(40 * k) },
    }),
  ];
  if (cv.headline) out.push(body(cv.headline, size, 40, k));
  const contact = contactLine(cv, true);
  if (contact) out.push(body(contact, size, 40, k));

  if (cv.summary.trim() !== '') out.push(heading('Professional Summary', headSize, k), body(cv.summary, size, 80, k));

  out.push(heading('Key Skills & Competencies', headSize, k));
  for (const c of cv.competencies ?? []) out.push(competency(c, size, k));
  for (const g of cv.skills) out.push(body(`${g.group}: ${g.items.join(', ')}`, size, 40, k));

  out.push(heading('Professional Experience', headSize, k));
  for (const job of cv.experience) {
    const lead = [job.title, job.employer].filter(Boolean);
    const parts = [
      { text: job.title, bold: true },
      { text: job.title && job.employer ? ', ' : '' },
      { text: job.employer, bold: true },
      { text: job.location ? `${lead.length > 0 ? ', ' : ''}${job.location}` : '' },
    ];
    out.push(titleLine(parts, job.dates, size, textWidth, k));
    if (job.bullets.length > 0) {
      out.push(label('Responsibilities', size, k));
      for (const b of job.bullets) out.push(bullet(b, size, k));
    }
    const achievements = job.achievements ?? [];
    if (achievements.length > 0) {
      out.push(label('Key Achievements', size, k));
      for (const a of achievements) out.push(bullet(a, size, k));
    }
  }

  if (cv.projects.length > 0) {
    out.push(heading('Projects', headSize, k));
    for (const p of cv.projects) {
      out.push(
        new Paragraph({
          children: [run(p.name, size)],
          keepNext: true,
          spacing: { before: Math.round(80 * k), after: Math.round(40 * k) },
        }),
      );
      for (const b of p.bullets) out.push(bullet(b, size, k));
    }
  }

  out.push(heading('Qualifications', headSize, k));
  for (const e of cv.education) {
    out.push(titleLine([{ text: educationLine(e) }], e.dates, size, textWidth, k));
    if (e.statusText) out.push(body(e.statusText, size, 40, k));
  }

  return out;
}

export async function renderAuGovernment(
  kind: DocKind,
  cv: TailoredCv,
  letter?: TailoredLetter,
  layout: CvLayout = LAYOUT_STEPS[0],
): Promise<Buffer> {
  // The government cover letter keeps the Standard ATS layout.
  if (kind === 'cover_letter') return renderStandardAts(kind, cv, letter, layout);
  const margin = layout.marginTwips;
  const footerRun = (opts: { text?: string; children?: (typeof PageNumber.CURRENT | typeof PageNumber.TOTAL_PAGES)[] }) =>
    new TextRun({ font: FONT, size: half(8), color: GREY, ...opts });
  const doc = new Document({
    creator: 'JobHunter',
    title: 'CV',
    styles: { default: { document: { run: { font: FONT, size: half(layout.bodyPt) } } } },
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
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  footerRun({ text: 'Page ' }),
                  footerRun({ children: [PageNumber.CURRENT] }),
                  footerRun({ text: ' of ' }),
                  footerRun({ children: [PageNumber.TOTAL_PAGES] }),
                ],
              }),
            ],
          }),
        },
        children: cvParagraphs(cv, layout),
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
