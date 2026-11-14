import type { FastifyInstance } from 'fastify';
import { docxToPdf, PdfRenderError, readPdf, type FetchLike } from '../render/pdf.js';
import { fitLayout } from '../render/fit.js';
import { renderDocx } from '../templates/index.js';
import { LAYOUT_STEPS } from '../templates/layout.js';
import {
  DOC_KINDS,
  RENDER_FORMATS,
  TEMPLATE_IDS,
  type DocKind,
  type RenderFormat,
  type TemplateId,
} from './types.js';
import { runChecks, type CheckInput } from './checks.js';
import { changedPaths } from './changedPaths.js';
import { InvalidDocumentError, validateTailoredCv, validateTailoredLetter } from './validate.js';

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface GenerationDeps {
  gotenbergUrl: string;
  // Test seam for the Gotenberg call.
  fetch?: FetchLike;
  // Directory with the check lists. Defaults to CONFIG_DIR or /app/config.
  configDir?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === 'string';

// Shape-checks the parts of a check request that are not the tailored documents. Returns the bad path or null.
function badCheckPath(b: Record<string, unknown>): string | null {
  if (!Array.isArray(b.keywordsCovered) || !b.keywordsCovered.every((k) => typeof k === 'string')) return 'keywordsCovered';
  const job = b.job;
  if (!isObj(job) || !strOrNull(job.title) || !strOrNull(job.employer) || !strOrNull(job.advertiser) || typeof job.rawText !== 'string') return 'job';
  if (!isObj(b.baseCv) || !isObj(b.baseCv.structured)) return 'baseCv';
  if (b.baseCoverLetter !== null && b.baseCoverLetter !== undefined && (!isObj(b.baseCoverLetter) || !isObj(b.baseCoverLetter.structured))) return 'baseCoverLetter';
  if (!Array.isArray(b.otherJobs) || !b.otherJobs.every((j) => isObj(j) && strOrNull(j.title) && strOrNull(j.employer) && strOrNull(j.advertiser))) return 'otherJobs';
  return null;
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
        let layout = LAYOUT_STEPS[0];
        if (doc === 'cv') {
          try {
            const measure = async (c: typeof validCv, l: typeof layout) =>
              readPdf(await docxToPdf(await renderDocx(templateId, 'cv', c, undefined, l), deps.gotenbergUrl, deps.fetch));
            layout = (await fitLayout(validCv, measure)).layout;
          } catch (err) {
            // A DOCX does not need Gotenberg: fall back to the normal layout. A PDF fails below as before.
            if (format === 'pdf') {
              request.log.error({ reason: err instanceof PdfRenderError ? err.message : 'unexpected' }, 'pdf render failed');
              return reply.code(502).send({ error: 'pdf_render_failed' });
            }
          }
        }
        docx = await renderDocx(templateId, doc, validCv, letter, layout);
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

  app.post<{ Body: Record<string, unknown> | undefined }>('/generation/check', async (request, reply) => {
    const body = request.body ?? {};
    if (!oneOf<TemplateId>(TEMPLATE_IDS, body.templateId)) return reply.code(400).send({ error: 'invalid_document', path: 'templateId' });
    let input: CheckInput;
    try {
      const cv = validateTailoredCv(body.cv);
      const coverLetter = validateTailoredLetter(body.coverLetter);
      const bad = badCheckPath(body);
      if (bad) throw new InvalidDocumentError(bad);
      input = { ...(body as unknown as CheckInput), templateId: body.templateId, cv, coverLetter, baseCoverLetter: (body.baseCoverLetter as CheckInput['baseCoverLetter']) ?? null };
    } catch (err) {
      if (err instanceof InvalidDocumentError) return reply.code(400).send({ error: 'invalid_document', path: err.path });
      throw err;
    }
    try {
      return await runChecks(input, { gotenbergUrl: deps.gotenbergUrl, fetch: deps.fetch, configDir: deps.configDir });
    } catch (err) {
      request.log.error({ reason: err instanceof PdfRenderError ? err.message : 'check failed' }, 'check failed');
      return reply.code(err instanceof PdfRenderError ? 502 : 500).send({ error: err instanceof PdfRenderError ? 'pdf_render_failed' : 'check_failed' });
    }
  });

  app.post<{ Body: { before?: unknown; after?: unknown } | undefined }>('/generation/changed-paths', async (request, reply) => {
    const body = request.body ?? {};
    const read = (name: 'before' | 'after') => {
      const side = body[name];
      if (!isObj(side)) throw new InvalidDocumentError(name);
      try {
        return { cv: validateTailoredCv(side.cv), coverLetter: validateTailoredLetter(side.coverLetter) };
      } catch (err) {
        if (err instanceof InvalidDocumentError) throw new InvalidDocumentError(`${name}.${err.path}`);
        throw err;
      }
    };
    try {
      return { paths: changedPaths(read('before'), read('after')) };
    } catch (err) {
      if (err instanceof InvalidDocumentError) return reply.code(400).send({ error: 'invalid_document', path: err.path });
      throw err;
    }
  });
}
