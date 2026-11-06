export type JobStatus = 'new' | 'cv_ready' | 'applied' | 'interviewing' | 'closed';
export type WarningCode = 'missing_url' | 'unreadable_file' | 'empty_description';
export type ScoreStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type ExtractionStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface MatchBreakdown {
  matched: string[];
  missing: string[];
  notes: string[];
}

export interface JobSummary {
  id: string;
  title: string | null;
  employer: string | null;
  advertiser: string | null;
  shortDescription: string | null;
  url: string | null;
  status: JobStatus;
  matchScore: number | null;
  matchExplanation: string | null;
  matchBreakdown: MatchBreakdown | null;
  scoreStatus: ScoreStatus;
  warnings: WarningCode[];
  extractionStatus: ExtractionStatus;
  sourceRemoved: boolean;
  sourceRef: string;
  createdAt: string;
}

export type DocumentKind = 'cv' | 'cover_letter';
export type DocumentWarningCode =
  | 'missing_work_rights'
  | 'degree_status_unclear'
  | 'banned_phrase'
  | 'unreadable_file'
  | 'extra_file_ignored';

export interface DocumentWarning {
  code: DocumentWarningCode;
  detail: string;
}

export interface BaseDocumentSummary {
  id: string;
  kind: DocumentKind;
  sourceRef: string;
  analysisStatus: ExtractionStatus;
  analysisError: string | null;
  warnings: DocumentWarning[];
  updatedAt: string;
}

export interface DocumentsResponse {
  cv: BaseDocumentSummary | null;
  coverLetter: BaseDocumentSummary | null;
  ignored: BaseDocumentSummary[];
}
