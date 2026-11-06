-- One base CV and one base cover letter (design change 2026-11-07).
-- Labels and the cross-CV conflict check only made sense with several CVs.
drop table base_document_checks;

alter table base_documents
  drop column label,
  drop column label_suggested,
  -- the one document of its kind that is used (newest readable file); every other file is ignored
  add column active boolean not null default false;

create unique index base_documents_one_active_per_kind on base_documents (owner_id, kind) where active;
