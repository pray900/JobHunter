import type { TailoredCv, TailoredLetter } from '../src/generation/types.js';

// Invented person; never real personal data.
export const CV: TailoredCv = {
  name: 'Jordan Testcase',
  headline: 'Backend Engineer',
  contact: {
    location: 'Sydney NSW',
    email: 'jordan@example.com',
    phone: '0400 000 000',
    links: [{ label: 'GitHub', url: 'https://github.com/jordan-testcase' }],
  },
  summary: 'Engineer who ships reliable services.',
  workRights: 'Australian citizen',
  skills: [{ group: 'Languages', items: ['TypeScript', 'SQL'] }],
  experience: [
    {
      title: 'Software Engineer',
      employer: 'Acme Pty Ltd',
      location: 'Sydney',
      dates: 'Jan 2022 - Present',
      bullets: ['Built an invoicing service.', 'Cut report time by half.'],
    },
  ],
  education: [{ qualification: 'BSc Computer Science', institution: 'Example University', dates: '2018 - 2021', statusText: 'Completed' }],
  projects: [{ name: 'Side Project', bullets: ['Small CLI tool.'] }],
};

export const LETTER: TailoredLetter = {
  date: '7 November 2026',
  addressee: 'Hiring Manager, Acme',
  salutation: 'Dear Hiring Manager,',
  paragraphs: ['I am applying for the role.', 'My experience fits.'],
  signOff: 'Kind regards,',
  name: 'Jordan Testcase',
};

// A valid PDF with the given number of pages.
export function makePdf(pages: number): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
