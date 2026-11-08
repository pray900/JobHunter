import { describe, expect, test } from 'vitest';
import { baseVersion } from './detailFixtures';
import { diffAgainstBase, type BaseCvStructured } from './diffAgainstBase';

const base: BaseCvStructured = {
  headline: 'Salesforce Developer',
  summary: 'Developer with Apex experience.',
  roles: [
    {
      title: 'Developer',
      employer: 'Acme',
      dates: '2020 - 2024',
      bullets: ['Built LWC components for the sales team', 'Maintained Apex triggers across three orgs', 'Ran the weekly release'],
    },
    { title: 'Intern', employer: 'Old Co', dates: '2019', bullets: ['Answered support tickets'] },
  ],
  skills: ['Apex', 'JavaScript', 'SOQL'],
  projects: [
    { name: 'JobHunter', bullets: ['Local job tracker.'] },
    { name: 'Side Thing', bullets: ['A toy.'] },
  ],
};

const cv = (over: Partial<typeof baseVersion.cv> = {}) => ({ ...baseVersion.cv, ...over });
const role = (bullets: string[], employer = 'Acme') => ({ title: 'Developer', employer, location: null, dates: '2020 - 2024', bullets });

describe('diffAgainstBase', () => {
  test('kept, reworded and added bullets', () => {
    const d = diffAgainstBase(
      base,
      cv({
        experience: [
          role([
            'Built LWC components for the sales team',
            'Maintained and tuned Apex triggers across three orgs',
            'Mentored two graduates',
          ]),
        ],
      }),
    );
    const bullets = d.roles[0]!.bullets;
    expect(bullets[0]).toMatchObject({ kind: 'kept' });
    expect(bullets[1]).toMatchObject({ kind: 'reworded', baseText: 'Maintained Apex triggers across three orgs' });
    expect(bullets[2]).toMatchObject({ kind: 'added', text: 'Mentored two graduates' });
  });

  test('dropped bullets and roles are listed', () => {
    const d = diffAgainstBase(base, cv({ experience: [role(['Built LWC components for the sales team'])] }));
    expect(d.roles[0]!.dropped).toEqual(['Maintained Apex triggers across three orgs', 'Ran the weekly release']);
    expect(d.rolesDropped).toEqual(['Old Co']);
  });

  test('skills added and dropped', () => {
    const d = diffAgainstBase(base, cv({ skills: [{ group: 'Tech', items: ['apex', 'LWC'] }] }));
    expect(d.skills.added).toEqual(['LWC']);
    expect(d.skills.dropped).toEqual(['JavaScript', 'SOQL']);
    expect(d.projects).toEqual({ kept: ['JobHunter'], dropped: ['Side Thing'] });
  });

  test('us/au and case differences count as kept', () => {
    const b: BaseCvStructured = { ...base, roles: [{ title: 'Dev', employer: 'Acme', dates: '', bullets: ['Optimize the  Color picker'] }] };
    const d = diffAgainstBase(b, cv({ experience: [role(['optimise the colour picker'], ' ACME ')] }));
    expect(d.roles[0]!.bullets[0]!.kind).toBe('kept');
    expect(d.rolesDropped).toEqual([]);
  });

  test('headline and summary changes', () => {
    const d = diffAgainstBase(base, cv({ headline: 'Apex Developer' }));
    expect(d.headline).toEqual({ before: 'Salesforce Developer', after: 'Apex Developer' });
  });
});
