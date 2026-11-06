export type DocumentKind = 'cv' | 'cover_letter';

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['cv', 'cover_letter'];

export const PDF_MEDIA_TYPE = 'application/pdf';
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ScannedDocument {
  kind: DocumentKind;
  sourceRef: string;
  contentHash: string;
  mediaType: typeof PDF_MEDIA_TYPE | typeof DOCX_MEDIA_TYPE;
  pdfBase64: string | null;
  text: string | null;
  warnings: 'unreadable_file'[];
}
