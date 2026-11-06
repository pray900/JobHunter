import fs from 'node:fs/promises';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import {
  DocumentFileReadError,
  InvalidDocumentNameError,
  MAX_DOCUMENT_BYTES,
  sanitiseDocumentName,
  type DocumentStore,
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
  store: DocumentStore,
  bannedPhrasesFile: string,
): void {
  // preservePath keeps "a/b.pdf" intact so it is rejected instead of silently trimmed to "b.pdf".
  void app.register(multipart, {
    preservePath: true,
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 5, parts: 6 },
  });

  // The stored documents with their content (PDF as base64, Word as text). At most one per kind.
  app.post('/documents/scan', async (request, reply) => {
    try {
      return { documents: await scanDocuments(store) };
    } catch (err) {
      if (err instanceof DocumentFileReadError) {
        request.log.error({ file: err.fileName, code: err.code }, 'document read failed');
      } else {
        request.log.error({ err }, 'document scan failed');
      }
      return reply.code(500).send({ error: 'document_scan_failed' });
    }
  });

  // Which documents are stored (name + content hash), without reading them. Cheap enough to poll.
  app.get('/documents', async (request, reply) => {
    try {
      const documents = [];
      for (const kind of DOCUMENT_KINDS) {
        const current = await store.currentDocument(kind);
        if (current) documents.push({ kind, sourceRef: current.name, contentHash: current.contentHash });
      }
      return { documents };
    } catch (err) {
      request.log.error({ err }, 'document list failed');
      return reply.code(500).send({ error: 'document_list_failed' });
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

  // Upload = replace: stores the file as this kind's one document and removes the previous one.
  app.post<{ Params: { kind: string } }>('/documents/:kind', async (request, reply) => {
    const { kind } = request.params;
    if (!isKind(kind)) return reply.code(404).send({ error: 'unknown_kind' });
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
      await store.saveDocument(kind, name, bytes);
      return reply.code(201).send({ sourceRef: name });
    } catch (err) {
      if (err instanceof InvalidDocumentNameError) return reply.code(400).send({ error: 'bad_file' });
      const code = (err as { code?: string })?.code;
      if (typeof code === 'string' && code.startsWith('FST_')) return reply.code(400).send({ error: 'bad_file' });
      request.log.error({ kind, code }, 'document upload failed');
      return reply.code(500).send({ error: 'document_upload_failed' });
    }
  });
}
