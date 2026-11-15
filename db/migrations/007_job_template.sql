-- The CV template: the one suggested when the job ad is read (with a one-sentence reason), and the one the
-- user chose on the job page. All null until set; a null choice means "use the suggestion".
alter table jobs
  add column suggested_template text check (suggested_template in ('standard-ats','au-government')),
  add column template_reason text,
  add column template_choice text check (template_choice in ('standard-ats','au-government'));
