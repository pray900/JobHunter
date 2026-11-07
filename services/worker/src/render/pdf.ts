import { getDocumentProxy, extractText } from 'unpdf';

export type FetchLike = typeof fetch;

export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfRenderError';
  }
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Converts a DOCX to PDF through Gotenberg (LibreOffice). Never logs the document.
export async function docxToPdf(docx: Buffer, gotenbergUrl: string, fetchImpl: FetchLike = fetch): Promise<Buffer> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(docx)], { type: DOCX_TYPE }), 'document.docx');
  let res: Response;
  try {
    res = await fetchImpl(`${gotenbergUrl.replace(/\/+$/, '')}/forms/libreoffice/convert`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PdfRenderError('gotenberg unreachable or timed out');
  }
  if (!res.ok) throw new PdfRenderError(`gotenberg answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfRenderError('gotenberg returned a non-PDF');
  return bytes;
}

// Page count and text, to check a rendered PDF.
export async function readPdf(pdf: Buffer): Promise<{ pages: number; text: string }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { totalPages, text } = await extractText(doc, { mergePages: true });
  return { pages: totalPages, text };
}
