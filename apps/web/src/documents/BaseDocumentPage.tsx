import type { DocumentKind } from '../api/types';

// Placeholder until Task 5 builds the real page.
export function BaseDocumentPage(props: { kind: DocumentKind }) {
  return <main className="page">{props.kind === 'cv' ? 'Your CV' : 'Your cover letter'}</main>;
}
