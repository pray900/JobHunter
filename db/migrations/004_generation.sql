-- Tailored CV / cover letter generation (plan 3).

create table generation_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  owner_id uuid not null references users(id),
  job_id uuid not null references jobs(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','in_progress','done','failed')),
  stage text default 'queued'
    check (stage in ('queued','writing','checking','reviewing','saving')),
  round int not null default 0,
  attempts int not null default 0,
  claimed_at timestamptz,
  error text,
  rounds jsonb not null default '[]',
  instruction text
);

create unique index generation_runs_one_active_per_job on generation_runs (job_id)
  where status in ('pending','in_progress');

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  owner_id uuid not null references users(id),
  job_id uuid not null references jobs(id) on delete cascade,
  run_id uuid references generation_runs(id) on delete set null,
  version_no int not null,
  label text not null,
  base_cv_id uuid references base_documents(id) on delete set null,
  base_cv_hash text not null,
  base_cover_letter_id uuid references base_documents(id) on delete set null,
  base_cover_letter_hash text,
  template_id text not null,
  cv jsonb not null,
  cover_letter jsonb not null,
  reasons jsonb not null,
  keyword_coverage jsonb not null,
  review jsonb not null,
  checks jsonb not null,
  instruction text,
  manual_edit boolean not null default false,
  unique (job_id, version_no)
);

alter table jobs add column company_notes text;
alter table cost_log add column generation_run_id uuid references generation_runs(id) on delete set null;

-- The CV analysis now records the person's name. Re-analyse the active CV once if it lacks one
-- (content hash is unchanged, so nothing is rescored).
update base_documents
  set analysis_status = 'pending', analysis_attempts = 0, analysis_claimed_at = null
  where kind = 'cv' and active and analysis_status = 'done' and not (structured ? 'name');
