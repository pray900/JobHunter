create table base_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  owner_id uuid not null references users(id),
  kind text not null check (kind in ('cv','cover_letter')),
  source_ref text not null,
  content_hash text not null,
  media_type text not null
    check (media_type in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  label text,
  label_suggested text,
  structured jsonb,
  warnings jsonb not null default '[]',
  analysis_status text not null default 'pending'
    check (analysis_status in ('pending','in_progress','done','failed','skipped')),
  analysis_attempts int not null default 0,
  analysis_claimed_at timestamptz,
  analysis_error text,
  source_removed boolean not null default false,
  unique (owner_id, kind, source_ref)
);

create table base_document_checks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  owner_id uuid not null references users(id),
  basis_hash text not null,
  conflicts jsonb not null,
  unique (owner_id, basis_hash)
);

alter table jobs
  add column score_status text not null default 'pending'
    check (score_status in ('pending','in_progress','done','failed','skipped')),
  add column score_attempts int not null default 0,
  add column score_claimed_at timestamptz,
  add column match_basis_hash text,
  add column match_breakdown jsonb;

alter table cost_log
  add column base_document_id uuid references base_documents(id) on delete set null;
