import type { FastifyInstance } from 'fastify';
import { docxToPdf, PdfRenderError, type FetchLike } from '../render/pdf.js';
import { renderDocx } from '../templates/index.js';
import {
  DOC_KINDS,
  RENDER_FORMATS,
  TEMPLATE_IDS,
  type DocKind,
  type RenderFormat,
  type TemplateId,
} from './types.js';
import { InvalidDocumentError, validateTailoredCv, validateTailoredLetter } from './validate.js';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface GenerationDeps {
  gotenbergUrl: string;
  // Test seam for the Gotenberg call.
  fetch?: FetchLike;
}

const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (list as readonly string[]).includes(x);

// Never logs document contents: only the bad path or a status.
export function registerGenerationRoutes(app: FastifyInstance, deps: GenerationDeps): void {
  app.post<{ Body: { templateId?: unknown; doc?: unknown; format?: unknown; cv?: unknown; coverLetter?: unknown } }>(
    '/generation/render',
    async (request, reply) => {
      const { templateId, doc, format, cv, coverLetter } = request.body ?? {};
      if (!oneOf<TemplateId>(TEMPLATE_IDS, templateId)) return reply.code(400).send({ error: 'invalid_document', path: 'templateId' });
      if (!oneOf<DocKind>(DOC_KINDS, doc)) return reply.code(400).send({ error: 'invalid_document', path: 'doc' });
      if (!oneOf<RenderFormat>(RENDER_FORMATS, format)) return reply.code(400).send({ error: 'invalid_document', path: 'format' });
      let docx: Buffer;
      try {
        const validCv = validateTailoredCv(cv);
        const letter = doc === 'cover_letter' ? validateTailoredLetter(coverLetter) : undefined;
        docx = await renderDocx(templateId, doc, validCv, letter);
      } catch (err) {
        if (err instanceof InvalidDocumentError) return reply.code(400).send({ error: 'invalid_document', path: err.path });
        request.log.error({ err }, 'render failed');
        return reply.code(500).send({ error: 'render_failed' });
      }
      if (format === 'docx') return reply.type(DOCX_TYPE).send(docx);
      try {
        const pdf = await docxToPdf(docx, deps.gotenbergUrl, deps.fetch);
        return reply.type('application/pdf').send(pdf);
      } catch (err) {
        request.log.error({ reason: err instanceof PdfRenderError ? err.message : 'unexpected' }, 'pdf render failed');
        return reply.code(502).send({ error: 'pdf_render_failed' });
      }
    },
  );
}
