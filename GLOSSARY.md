# JobHunter

Turns job ads into tailored, honest CVs and cover letters, and tracks where each application stands.

## Jobs

**Job**:
One opportunity Prayush might apply for, created from exactly one job file; it carries the application status.
_Avoid_: Listing, posting, application (as a separate thing)

**Application status**:
Where Prayush stands with a job: New, CV ready, Applied, Interviewing or Closed.
_Avoid_: Status (when extraction or review status could be meant), stage

**Job file**:
A Word document in the job folder holding one job ad, with the posting link on its first non-empty line.
_Avoid_: Listing file, job doc

**Job ad**:
The text of a job advertisement as copied from a job site, including any site clutter.
_Avoid_: Job description (when meaning the whole pasted text), JD, posting text

**Posting link**:
The web address of the job ad on the job site it came from.
_Avoid_: Job URL, apply link

**Employer**:
The organisation that would actually hire Prayush; unknown when the ad doesn't name it.
_Avoid_: Company (when an advertiser is involved), client

**Advertiser**:
A recruiter or agency that posts a job ad on behalf of an employer.
_Avoid_: Company, poster

## Documents

**Base CV**:
Prayush's own CV as he uploaded it, with any corrections he made in the app; it is the only source of facts.
_Avoid_: Master CV, original CV, template

**Base cover letter**:
Prayush's own cover letter, used only as a sample of tone and reusable paragraphs.
_Avoid_: Template letter

**Base edit**:
A correction Prayush makes in the app to the facts read from his base CV or cover letter; it replaces those facts everywhere until he undoes it or replaces the file.
_Avoid_: Override, manual edit (which is a change to a tailored version).

**Tailored CV**:
A CV written for one job from the base CV.
_Avoid_: Custom CV, generated CV, new CV

**Template**:
The look of a tailored CV or cover letter (font, layout, section order, length and content rules), separate from its words.
_Avoid_: Style, format, theme

**Version**:
One saved pair of a tailored CV and cover letter for a job; versions are only ever added, never changed or deleted, and the current version is the one with the highest number.
_Avoid_: Draft, revision, copy

**Origin**:
Where a version came from: Generated, Regenerated (with an instruction), Edited (by Prayush) or Restored (a copy of an older version).
_Avoid_: Source, type

**Manual edit**:
A field Prayush changed by hand in a version, kept by its text; on a regenerate it is locked and copied exactly.
_Avoid_: Override, user change

**Instruction**:
Prayush's own request for a regenerate, such as "Make the summary shorter"; it never overrides the honesty rules outside his manual edits.
_Avoid_: Prompt, command

**Regenerate**:
Asking Claude for a new version of the version on screen, following an instruction and keeping the manual edits.
_Avoid_: Rewrite, Generate again (which starts from the base CV)

## Judgement

**Match score**:
How well Prayush fits a job, judged from the base CV against the job ad, with a stated explanation.
_Avoid_: Fit score, rating

**Keyword coverage**:
How many of a job ad's important terms a particular tailored CV contains.
_Avoid_: Match score (a different thing)

**Writer**:
The Claude role that produces a tailored CV, cover letter and reasons.

**Reviewer**:
The independent Claude role, acting as a senior recruiter and ATS specialist, that checks the writer's work and sends objections back.
_Avoid_: Checker, validator, critic

**Hard fail**:
A problem that stops a tailored CV or cover letter from passing review, such as an invented fact or a second page.
_Avoid_: Error, warning

**Stretch**:
A claim that is supported by the base CV but framed close to the line, shown to Prayush to decide. Also an estimated result or scale figure the writer added to a bullet that the base CV does not state.
_Avoid_: Exaggeration, lie
