import type { JobStatus, WarningCode } from '../api/types';

export const STATUSES: JobStatus[] = ['new', 'cv_ready', 'applied', 'interviewing', 'closed'];

const STATUS_LABELS: Record<JobStatus, string> = {
  new: 'New',
  cv_ready: 'CV ready',
  applied: 'Applied',
  interviewing: 'Interviewing',
  closed: 'Closed',
};

const WARNING_TEXT: Record<WarningCode, string> = {
  missing_url: 'No job link found on the first line',
  unreadable_file: "Couldn't read this file",
  empty_description: 'No job description found',
};

export function statusLabel(s: JobStatus): string {
  return STATUS_LABELS[s];
}

export function warningText(w: WarningCode): string {
  return WARNING_TEXT[w];
}
