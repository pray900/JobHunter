import fs from 'node:fs/promises';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import {
  DocumentExistsError,
  DocumentFileReadError,
  DocumentFolderMissingError,
  DocumentNotFoundError,
  InvalidDocumentNameError,
  MAX_DOCUMENT_BYTES,
  sanitiseDocumentName,
  type DocumentFolders,
} from '../storage/documentFolder.js';
import { checkBaseCoverLetter, checkBaseCv, parseBannedPhrases } from './checks.js';
import { scanDocuments } from './scan.js';
import {
  DOCUMENT_KINDS,
  type BaseCoverLetterFacts,
  type BaseCvFacts,
  type DocumentKind,
} from './types.js';

const isKind = (s: string): s is DocumentKind => (DOCUMENT_KINDS as readonly string[]).includes(s);

// Content checks: the bytes must look like what the extension claims.
function bytesMatchExtension(name: string, bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  if (/\.pdf$/i.test(name)) return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// Never logs document contents.
export function registerDocumentRoutes(
  app: FastifyInstance,
  folders: DocumentFolders,
  bannedPhrasesFile: string,
): void {
  // preservePath keeps "a/b.pdf" intact so it is rejected instead of silently trimmed to "b.pdf".
  void app.register(multipart, {
    preservePath: true,
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5, parts: 6 },
  });

  app.post('/documents/scan', async (request, reply) => {
    try {
      return { documents: await scanDocuments(folders) };
    } catch (err) {
      if (err instanceof DocumentFolderMissingError) {
        request.log.error({ kind: err.kind, folder: err.dir, code: 'ENOENT' }, 'document folder missing');
        return reply.code(503).send({ error: 'document_folder_missing', kind: err.kind });
      }
      if (err instanceof DocumentFileReadError) {
        request.log.error({ file: err.fileName, code: err.code }, 'document read failed');
      } else {
        request.log.error({ err }, 'document scan failed');
      }
      return reply.code(500).send({ error: 'document_scan_failed' });
    }
  });

  // Pure checks on analysed facts. The phrase list is read per request, so edits apply without a restart.
  app.post<{ Body: { kind?: unknown; facts?: unknown } }>('/documents/checks', async (request, reply) => {
    const { kind, facts } = request.body ?? {};
    if (typeof kind !== 'string' || !isKind(kind) || !facts || typeof facts !== 'object') {
      return reply.code(400).send({ error: 'bad_request' });
    }
    try {
      const bannedPhrases = parseBannedPhrases(await fs.readFile(bannedPhrasesFile, 'utf8'));
      const warnings =
        kind === 'cv'
          ? checkBaseCv(facts as BaseCvFacts, bannedPhrases)
          : checkBaseCoverLetter(facts as BaseCoverLetterFacts, bannedPhrases);
      return { warnings };
    } catch (err) {
      request.log.error({ kind, file: bannedPhrasesFile, err }, 'document checks failed');
      return reply.code(500).send({ error: 'document_checks_failed' });
    }
  });

  app.post<{ Params: { kind: string }; Querystring: { replace?: string } }>(
    '/documents/:kind',
    async (request, reply) => {
      const { kind } = request.params;
      if (!isKind(kind)) return reply.code(404).send({ error: 'unknown_kind' });
      const replace = request.query.replace === 'true';
      try {
        const part = await request.file();
        if (!part) return reply.code(400).send({ error: 'bad_file' });
        const name = sanitiseDocumentName(part.filename);
        if (!name) {
          part.file.resume();
          return reply.code(400).send({ error: 'bad_file' });
        }
        const bytes = await part.toBuffer();
        if (part.file.truncated || !bytesMatchExtension(name, bytes)) {
          return reply.code(400).send({ error: 'bad_file' });
        }
        // Replacing targets a hand-placed file with this exact name if one exists, not a sanitised twin.
        const target = replace ? ((await folders.findDocument(kind, part.filename)) ?? name) : name;
        await folders.writeDocument(kind, target, bytes, { replace });
        return reply.code(201).send({ sourceRef: target });
      } catch (err) {
        if (err instanceof DocumentExistsError) return reply.code(409).send({ error: 'document_exists' });
        if (err instanceof InvalidDocumentNameError) return reply.code(400).send({ error: 'bad_file' });
        const code = (err as { code?: string })?.code;
        if (typeof code === 'string' && code.startsWith('FST_')) return reply.code(400).send({ error: 'bad_file' });
        if (err instanceof DocumentFolderMissingError) {
          request.log.error({ kind: err.kind, folder: err.dir, code: 'ENOENT' }, 'document folder missing');
          return reply.code(503).send({ error: 'document_folder_missing', kind: err.kind });
        }
        request.log.error({ kind, err }, 'document upload failed');
        return reply.code(500).send({ error: 'document_upload_failed' });
      }
    },
  );

  app.delete<{ Params: { kind: string; name: string } }>('/documents/:kind/:name', async (request, reply) => {
    const { kind, name } = request.params;
    if (!isKind(kind)) return reply.code(404).send({ error: 'unknown_kind' });
    try {
      await folders.deleteDocument(kind, name);
      return reply.code(204).send();
    } catch (err) {
      // An unsafe name can never match a file in the folder, so it is simply not found.
      if (err instanceof DocumentNotFoundError || err instanceof InvalidDocumentNameError) {
        return reply.code(404).send({ error: 'document_not_found' });
      }
      request.log.error({ kind, err }, 'document delete failed');
      return reply.code(500).send({ error: 'document_delete_failed' });
    }
  });
}
