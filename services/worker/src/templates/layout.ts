// Layout knobs the CV fit step turns to shrink a CV onto one page.
export interface CvLayout {
  bodyPt: number;
  marginTwips: number;
  /** Multiplies every paragraph spacing value in the CV. */
  spacing: number;
}

// Index 0 is the normal layout; the last step is the floor.
export const LAYOUT_STEPS: readonly CvLayout[] = [
  { bodyPt: 10.5, marginTwips: 1020, spacing: 1 },
  { bodyPt: 10.5, marginTwips: 1020, spacing: 0.6 },
  { bodyPt: 10.5, marginTwips: 850, spacing: 0.6 },
  { bodyPt: 10.5, marginTwips: 720, spacing: 0.6 },
  { bodyPt: 10, marginTwips: 720, spacing: 0.6 },
  { bodyPt: 9.5, marginTwips: 720, spacing: 0.6 },
];

export const shortLink = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
