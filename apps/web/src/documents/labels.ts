import type { DocumentWarning } from '../api/types';

export function documentWarningText(w: DocumentWarning): string {
  switch (w.code) {
    case 'missing_work_rights':
      return 'No work-rights line (e.g. "Full working rights (485 visa)")';
    case 'degree_status_unclear':
      return 'Degree status unclear — say e.g. "(conferral Nov 2026)"';
    case 'banned_phrase':
      return `Phrase that reads as AI or cliché: ${w.detail}`;
    case 'unreadable_file':
      return "Couldn't read this file";
    default:
      // Any code added later: the API's own detail text.
      return w.detail;
  }
}

export function uploadErrorText(status: number): string {
  if (status === 400 || status === 413) return "That file can't be used. Upload a PDF or Word file under 5 MB.";
  return "Couldn't upload that file. Try again.";
}
