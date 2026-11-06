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
      // extra_file_ignored, and any code added later: the API's own detail text.
      return w.detail;
  }
}

export function uploadErrorText(status: number): string {
  if (status === 409) return 'A file with that name is already in the folder. Rename your file and try again.';
  if (status === 400 || status === 413) return "That file can't be used. Upload a PDF or Word file under 5 MB.";
  if (status === 503) return 'Your documents folder is missing. Check the folder path in .env.';
  return "Couldn't upload that file. Try again.";
}
