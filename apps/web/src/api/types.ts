export type JobStatus = 'new' | 'cv_ready' | 'applied' | 'interviewing' | 'closed';
export type WarningCode = 'missing_url' | 'unreadable_file' | 'empty_description';
export type ScoreStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type ExtractionStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface MatchBreakdown {
  matched: string[];
  missing: string[];
  notes: string[];
}

export type RunStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export type RunStage = 'queued' | 'writing' | 'checking' | 'reviewing' | 'saving';

export interface GenerationSummary {
  status: RunStatus;
  stage: RunStage;
  round: number;
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
  // Latest generation run (null when none) and whether a generated version exists.
  generation?: GenerationSummary | null;
  hasVersion?: boolean;
}

export type DocumentKind = 'cv' | 'cover_letter';
export type DocumentWarningCode =
  | 'missing_work_rights'
  | 'degree_status_unclear'
  | 'banned_phrase'
  | 'unreadable_file';

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
  edited: boolean;
  editedAt: string | null;
  updatedAt: string;
}

// Facts Claude read from a base CV (mirrors the worker's BaseCvFacts).
export interface BaseCvFacts {
  name: string | null;
  headline: string | null;
  summary: string | null;
  workRights: string | null;
  education: { qualification: string; institution: string; dates: string; statusText: string }[];
  roles: { title: string; employer: string; dates: string; bullets: string[] }[];
  projects: { name: string; bullets: string[] }[];
  skills: string[];
  metrics: string[];
  contact: { location: string | null; email: string | null; phone: string | null; links: string[] };
}

export interface BaseCoverLetterFacts {
  previousTarget: { company: string | null; addressee: string | null; role: string | null };
  reusableParagraphs: string[];
  toneNotes: string;
}

// GET/POST /api/documents/facts. `facts` are the effective facts (edited if edited, else as read).
export interface BaseDocumentFacts {
  id: string;
  kind: DocumentKind;
  sourceRef: string;
  mediaType: string;
  contentHash: string;
  facts: BaseCvFacts | BaseCoverLetterFacts;
  edited: boolean;
  editedAt: string | null;
  warnings: DocumentWarning[];
  // Jobs a CV edit re-scores; 0 for a cover letter.
  rescoreJobs: number;
}

// The one uploaded CV and the one uploaded cover letter; null when that slot is empty.
export interface DocumentsResponse {
  cv: BaseDocumentSummary | null;
  coverLetter: BaseDocumentSummary | null;
}

// ---- Job page (GET /api/jobs/detail) ----

export interface Generation extends GenerationSummary {
  attempts: number;
  error: string | null;
  // What the run was asked to do: both null for a plain Generate, both set for a Regenerate.
  instruction?: string | null;
  fromVersionId?: string | null;
}

export interface JobDetailJob {
  id: string;
  title: string | null;
  employer: string | null;
  advertiser: string | null;
  url: string | null;
  status: JobStatus;
  rawText: string | null;
  matchScore: number | null;
  matchExplanation: string | null;
  matchBreakdown: MatchBreakdown | null;
  warnings: WarningCode[];
  companyNotes: string | null;
}

export interface TailoredCv {
  name: string;
  headline: string;
  contact: {
    location: string | null;
    email: string | null;
    phone: string | null;
    links: { label: string; url: string }[];
  };
  summary: string;
  workRights: string | null;
  skills: { group: string; items: string[] }[];
  experience: { title: string; employer: string; location: string | null; dates: string; bullets: string[] }[];
  education: { qualification: string; institution: string; dates: string; statusText: string }[];
  projects: { name: string; bullets: string[] }[];
}

export interface TailoredLetter {
  date: string;
  addressee: string;
  salutation: string;
  paragraphs: string[];
  signOff: string;
  name: string;
}

export type CheckCode =
  | 'cv_pages'
  | 'letter_pages'
  | 'placeholder'
  | 'company_leakage'
  | 'title_leakage'
  | 'banned_phrase'
  | 'us_spelling'
  | 'tech_casing'
  | 'unknown_fact'
  | 'keyword_not_found'
  | 'link_invalid'
  | 'render_text'
  | 'unmatched_skill'
  | 'possible_misspelling'
  | 'missing_work_rights'
  | 'work_rights_dropped'
  | 'link_unreachable'
  | 'invalid_document'
  | 'manual_edit_changed';

export type ReviewItemId =
  | 'relevance'
  | 'over_tailoring'
  | 'strongest_match_top_third'
  | 'inflated_scope'
  | 'ai_sounding'
  | 'paraphrased_job_ad'
  | 'keyword_stuffing'
  | 'bullet_rhythm'
  | 'star_form'
  | 'tidiness'
  | 'keyword_coverage_honest'
  | 'reasons_hold_up'
  | 'cover_letter_sources'
  | 'addressee';

export interface CheckResult {
  code: CheckCode;
  severity: 'hard' | 'warning' | 'review';
  doc: 'cv' | 'cover_letter';
  detail: string;
  where?: string;
  // Inside one of Prayush's locked manual edits (a regenerate kept it as he asked).
  locked?: boolean;
}

export interface Stretch {
  target: string;
  text: string;
  why: string;
}

export interface VersionReasons {
  templateReason: string;
  changes: { target: string; what: string; why: string }[];
  stretches: Stretch[];
  factRulings: { text: string; ruling: 'honest_rephrase' | 'invented'; why: string }[];
}

export interface KeywordCoverage {
  covered: string[];
  missing: { keyword: string; why: string }[];
}

export type UnresolvedItem =
  | (CheckResult & { source: 'check'; note?: string })
  | { source: 'review'; id: ReviewItemId; note: string }
  | { source: 'fact'; text: string; why: string }
  | { source: 'spelling'; word: string; fix: string | null };

export interface VersionReview {
  passed: boolean;
  // Set on edited versions: the version whose review this is (the reviewer is not re-run on edits).
  reviewedVersionNo?: number;
  rounds: number;
  verdicts: ('pass' | 'fail')[];
  unresolved: UnresolvedItem[];
}

export type VersionOrigin = 'generated' | 'regenerated' | 'edited' | 'restored';

// One of Prayush's manual edits: where it is (a dotted path such as cv.experience[0].bullets[2]) and what he
// wrote there (null: a field he emptied). Kept by text: it moves with its text.
export interface ManualEdit {
  path: string;
  text: string | null;
}

export interface DocumentVersion {
  id: string;
  versionNo: number;
  label: string;
  origin: VersionOrigin;
  parentVersionId: string | null;
  // The fields Prayush changed by hand, by text (empty when never edited).
  manualEdits: ManualEdit[];
  isCurrent: boolean;
  createdAt: string;
  templateId: string;
  cv: TailoredCv;
  coverLetter: TailoredLetter;
  reasons: VersionReasons;
  keywordCoverage: KeywordCoverage;
  review: VersionReview;
  checks: CheckResult[];
  baseCvSourceRef: string | null;
  costUsd: number;
}

export interface VersionBaseCv {
  structured: TailoredCv | Record<string, unknown>;
  sourceRef: string | null;
  isCurrentBase: boolean;
}

export interface JobDetail {
  job: JobDetailJob;
  generation: Generation | null;
  version: DocumentVersion | null;
  // How many versions the job has.
  versions: number;
  // The base CV the shown version was made from, or null when it is gone or has changed.
  baseCv: VersionBaseCv | null;
}

export interface VersionSummary {
  id: string;
  versionNo: number;
  label: string;
  origin: VersionOrigin;
  createdAt: string;
  instruction: string | null;
  // null = not reviewed (an edited version: the verdict belongs to an earlier version).
  passed: boolean | null;
  hardChecks: number;
  manualEdit: boolean;
}

export interface SaveEditResult {
  versionId: string;
  versionNo: number;
  checks: CheckResult[];
}

export type DownloadDoc = 'cv' | 'cover_letter';
export type DownloadFormat = 'docx' | 'pdf';
