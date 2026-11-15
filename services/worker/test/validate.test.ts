import { describe, expect, test } from 'vitest';
import { InvalidDocumentError, validateTailoredCv } from '../src/generation/validate.js';
import { CV } from './fixtures.js';

describe('validateTailoredCv government fields', () => {
  test('absent competencies and achievements stay absent', () => {
    const out = validateTailoredCv(CV);
    expect('competencies' in out).toBe(false);
    expect('achievements' in out.experience[0]).toBe(false);
  });

  test('present competencies and achievements are kept', () => {
    const cv = {
      ...CV,
      competencies: ['Stakeholder engagement: ran weekly reviews'],
      experience: [{ ...CV.experience[0], achievements: ['Cut costs'] }],
    };
    const out = validateTailoredCv(cv);
    expect(out.competencies).toEqual(['Stakeholder engagement: ran weekly reviews']);
    expect(out.experience[0].achievements).toEqual(['Cut costs']);
  });

  test('an empty competency names its path', () => {
    try {
      validateTailoredCv({ ...CV, competencies: [''] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDocumentError);
      expect((err as InvalidDocumentError).path).toBe('cv.competencies[0]');
    }
  });

  test('an empty achievement names its path', () => {
    try {
      validateTailoredCv({ ...CV, experience: [{ ...CV.experience[0], achievements: ['ok', ' '] }] });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as InvalidDocumentError).path).toBe('cv.experience[0].achievements[1]');
    }
  });
});
