alter table document_versions
  add column origin text not null default 'generated' check (origin in ('generated','regenerated','edited','restored')),
  add column parent_version_id uuid references document_versions(id) on delete set null;

alter table generation_runs
  add column from_version_id uuid references document_versions(id) on delete set null;
