import { readDocxBlocks } from '../jobs/docxBlocks.js';
import type { DocumentFolders } from '../storage/documentFolder.js';
import { DOCUMENT_KINDS, DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE, type DocumentKind, type ScannedDocument } from './types.js';

async function scanKind(folders: DocumentFolders, kind: DocumentKind): Promise<ScannedDocument[]> {
  const files = await folders.listDocuments(kind);
  return Promise.all(
    files.map(async (file): Promise<ScannedDocument> => {
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
        return { ...base, pdfBase64: null, text, warnings: [] };
      } catch {
        return { ...base, pdfBase64: null, text: null, warnings: ['unreadable_file'] };
      }
    }),
  );
}

// Folders are scanned in order, so a missing CV folder is reported before the cover letter one.
export async function scanDocuments(folders: DocumentFolders): Promise<ScannedDocument[]> {
  const out: ScannedDocument[] = [];
  for (const kind of DOCUMENT_KINDS) out.push(...(await scanKind(folders, kind)));
  return out;
}
