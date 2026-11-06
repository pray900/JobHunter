export type JobStatus = 'new' | 'cv_ready' | 'applied' | 'interviewing' | 'closed';
export type WarningCode = 'missing_url' | 'unreadable_file' | 'empty_description';
export type ExtractionStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface JobSummary {
  id: string;
  title: string | null;
  employer: string | null;
  advertiser: string | null;
  shortDescription: string | null;
  url: string | null;
  status: JobStatus;
  matchScore: number | null;
  warnings: WarningCode[];
  extractionStatus: ExtractionStatus;
  sourceRemoved: boolean;
  sourceRef: string;
  createdAt: string;
}
