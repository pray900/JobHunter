import type { DocKind, TailoredCv, TailoredLetter, TemplateId } from '../generation/types.js';
import { renderStandardAts } from './standardAts.js';

export async function renderDocx(
  templateId: TemplateId,
  kind: DocKind,
  cv: TailoredCv,
  letter?: TailoredLetter,
): Promise<Buffer> {
  switch (templateId) {
    case 'standard-ats':
      return renderStandardAts(kind, cv, letter);
  }
}
