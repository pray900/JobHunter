-- Edited facts replace what Claude read from the file; facts_hash is the basis of the document.
alter table base_documents
  add column edited_facts jsonb,
  add column edited_at timestamptz,
  add column facts_hash text generated always as (
    case when edited_facts is null then content_hash else content_hash || ':' || md5(edited_facts::text) end
  ) stored;
