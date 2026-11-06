import { readDocxBlocks } from '../jobs/docxBlocks.js';
import type { DocumentStore } from '../storage/documentFolder.js';
import { DOCUMENT_KINDS, DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE, type DocumentKind, type ScannedDocument } from './types.js';

async function scanKind(store: DocumentStore, kind: DocumentKind): Promise<ScannedDocument | null> {
  const file = await store.readDocument(kind);
  if (file === null) return null;
  const isPdf = /\.pdf$/i.test(file.name);
  const base = {
    kind,
    sourceRef: file.name,
    contentHash: file.contentHash,
    mediaType: isPdf ? PDF_MEDIA_TYPE : DOCX_MEDIA_TYPE,
  } as const;
  // Over the size limit: reported as unreadable, hash kept so changes are still detected.
  if (file.bytes === null) return { ...base, pdfBase64: null, text: null, warnings: ['unreadable_file'] };
  if (isPdf) return { ...base, pdfBase64: file.bytes.toString('base64'), text: null, warnings: [] };
  try {
    const text = (await readDocxBlocks(file.bytes)).map((b) => b.text).join('\n');
    // No readable text: never sent to Claude.
    if (text.trim() === '') return { ...base, pdfBase64: null, text: null, warnings: ['unreadable_file'] };
    return { ...base, pdfBase64: null, text, warnings: [] };
  } catch {
    return { ...base, pdfBase64: null, text: null, warnings: ['unreadable_file'] };
  }
}

// The stored CV and cover letter (at most one of each), CV first.
export async function scanDocuments(store: DocumentStore): Promise<ScannedDocument[]> {
  const out: ScannedDocument[] = [];
  for (const kind of DOCUMENT_KINDS) {
    const doc = await scanKind(store, kind);
    if (doc) out.push(doc);
  }
  return out;
}
