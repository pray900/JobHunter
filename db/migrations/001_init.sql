create table users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  name text not null
);

insert into users (id, name) values ('00000000-0000-0000-0000-000000000001', 'Prayush');

create table jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  owner_id uuid not null references users(id),
  source text not null,
  source_ref text not null,
  content_hash text not null,
  url text,
  raw_text text not null,
  warnings jsonb not null default '[]',
  title text,
  employer text,
  advertiser text,
  short_description text,
  extraction_status text not null default 'pending'
    check (extraction_status in ('pending','in_progress','done','failed','skipped')),
  extraction_attempts int not null default 0,
  extraction_claimed_at timestamptz,
  status text not null default 'new'
    check (status in ('new','cv_ready','applied','interviewing','closed')),
  match_score int,
  match_explanation text,
  source_removed boolean not null default false,
  updated_at timestamptz default now(),
  unique (owner_id, source, source_ref)
);

create table job_status_history (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  job_id uuid not null references jobs(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_at timestamptz default now()
);

create table cost_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  owner_id uuid not null references users(id),
  job_id uuid references jobs(id) on delete set null,
  purpose text not null,
  model text not null,
  input_tokens int not null,
  output_tokens int not null,
  cost_usd numeric(10,6) not null
);
