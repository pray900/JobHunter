import type { DocKind, TailoredCv, TailoredLetter, TemplateId } from '../generation/types.js';
import { LAYOUT_STEPS, type CvLayout } from './layout.js';
import { renderStandardAts } from './standardAts.js';

export async function renderDocx(
  templateId: TemplateId,
  kind: DocKind,
  cv: TailoredCv,
  letter?: TailoredLetter,
  layout: CvLayout = LAYOUT_STEPS[0],
): Promise<Buffer> {
  switch (templateId) {
    case 'standard-ats':
      return renderStandardAts(kind, cv, letter, layout);
    case 'au-government':
      return renderStandardAts(kind, cv, letter, layout); // Task 3 replaces this
  }
}
