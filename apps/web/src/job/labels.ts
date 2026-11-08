import type { CheckCode, ReviewItemId, VersionOrigin } from '../api/types';

const CHECK_LABELS: Record<CheckCode, string> = {
  cv_pages: 'CV is longer than 1 page',
  letter_pages: 'Cover letter is longer than 2 pages',
  placeholder: 'Leftover placeholder text',
  company_leakage: "Another company's name appears",
  title_leakage: "Another job's title appears",
  banned_phrase: 'Banned phrase used',
  us_spelling: 'US spelling used',
  tech_casing: 'Technology name written incorrectly',
  unknown_fact: 'Not in your base CV',
  keyword_not_found: 'Keyword listed as covered but not in the CV',
  link_invalid: 'Link is not valid',
  render_text: 'Text missing from the rendered document',
  unmatched_skill: 'Technology not in your base CV',
  possible_misspelling: 'Possible misspelling',
  missing_work_rights: 'Your base CV has no work-rights line',
  work_rights_dropped: 'Work-rights line left out',
  link_unreachable: "Link didn't answer",
  invalid_document: 'A required part of the document was missing or empty',
  manual_edit_changed: 'Your edit was changed',
};

// The note a regenerate puts on a check inside one of Prayush's locked edits (generate-documents).
export const LOCKED_NOTE = 'Your edit — kept as you asked';

const REVIEW_LABELS: Record<ReviewItemId, string> = {
  relevance: 'Relevant to this job',
  over_tailoring: 'Tailored too heavily',
  strongest_match_top_third: 'Strongest match in the top third',
  inflated_scope: 'Scope or seniority inflated',
  ai_sounding: 'Sounds like AI wrote it',
  paraphrased_job_ad: 'Copies the job ad too closely',
  keyword_stuffing: 'Keywords stuffed in',
  bullet_rhythm: 'Bullets all read the same',
  star_form: 'Bullets lack action and result',
  tidiness: 'Tidiness and consistency',
  keyword_coverage_honest: 'Keyword coverage claims are honest',
  reasons_hold_up: 'Reasons given hold up',
  cover_letter_sources: 'Cover letter claims come from your documents',
  addressee: 'Letter addressed correctly',
};

export const CHECK_CODES = Object.keys(CHECK_LABELS) as CheckCode[];
export const REVIEW_ITEM_IDS = Object.keys(REVIEW_LABELS) as ReviewItemId[];

export const checkLabel = (code: CheckCode): string => CHECK_LABELS[code];
export const reviewItemLabel = (id: ReviewItemId): string => REVIEW_LABELS[id];

export const STAGE_TEXT = {
  queued: 'Waiting to start…',
  writing: 'Writing…',
  checking: 'Checking…',
  reviewing: 'Reviewing…',
  saving: 'Saving…',
} as const;

// "Writing… round 2"; the queue has no round yet.
export function progressText(stage: keyof typeof STAGE_TEXT, round: number): string {
  return stage === 'queued' || round < 1 ? STAGE_TEXT[stage] : `${STAGE_TEXT[stage]} round ${round}`;
}

// Where a version came from. The icon is decoration; the text always shows.
export const ORIGIN_TEXT: Record<VersionOrigin, string> = {
  generated: 'Generated',
  regenerated: 'Regenerated',
  edited: 'Edited by you',
  restored: 'Restored',
};
export const ORIGIN_ICON: Record<VersionOrigin, string> = {
  generated: '✦',
  regenerated: '↻',
  edited: '✎',
  restored: '⟲',
};

export function hardChecksText(n: number): string {
  return n === 1 ? '1 hard check' : `${n} hard checks`;
}
