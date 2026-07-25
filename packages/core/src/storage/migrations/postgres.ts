/** Postgres schema (pgvector + tsvector + GIN). */

export function postgresSchema(schema: string, dims: number): string {
  const s = schema || "public";
  return `
create schema if not exists "${s}";
create extension if not exists vector;

create table if not exists "${s}".facts (
  id bigint generated always as identity primary key,
  scope text not null default 'global',
  category text not null default '',
  fact text not null,
  detail text,
  topic_key text,
  pinned boolean not null default false,
  -- column default stays 0 (existing rows must not shift); the app-level
  -- default of 0.6 is applied in factsAdd (postgres.ts), not here.
  importance real not null default 0,
  status text not null default 'active',
  created_by text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  embedding vector(${dims}),
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(fact,'') || ' ' || coalesce(detail,''))
  ) stored
);

create table if not exists "${s}".sessions (
  id bigint generated always as identity primary key,
  machine text,
  project text,
  workspace text,
  agent text,
  summary text not null,
  details text,
  tags text[],
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  embedding vector(${dims}),
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(summary,'') || ' ' || coalesce(details,''))
  ) stored
);

create table if not exists "${s}".docs (
  id bigint generated always as identity primary key,
  source text not null default 'default',
  path text not null,
  title text not null default '',
  body text not null,
  chunk_idx integer not null default 0,
  total_chunks integer not null default 1,
  body_hash text not null,
  mtime timestamptz,
  status text not null default 'active',
  kind text,
  machine text,
  scope text not null default 'global',
  ingested_at timestamptz not null default now(),
  embedding vector(${dims}),
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
  ) stored
);

-- docs scope lane (stage 3): idempotent add for cabinets created before this column existed.
alter table "${s}".docs add column if not exists scope text not null default 'global';

create table if not exists "${s}".vision (
  id bigint generated always as identity primary key,
  scope text not null default 'global',
  details text not null,
  summary text,
  created_by text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- vision went in-place-only: drop the vestigial status column + partial index
-- from cabinets created earlier (idempotent; no-op on fresh cabinets).
drop index if exists "${s}".idx_vision_active;
alter table "${s}".vision drop column if exists status;

-- summary/details split: cabinets created before this column existed have a
-- content column instead of details. alter table rename column has no
-- IF EXISTS for the source side, so guard it. Non-destructive: renames data
-- in place, never drops it; summary is added nullable so existing rows keep
-- working via the details-truncation fallback (engine/brief.ts).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = '${s}' and table_name = 'vision' and column_name = 'content'
  ) then
    alter table "${s}".vision rename column content to details;
  end if;
end $$;
alter table "${s}".vision add column if not exists summary text;

create unique index if not exists idx_docs_path_chunk on "${s}".docs(path, chunk_idx);
create unique index if not exists idx_vision_scope on "${s}".vision(scope);
create index if not exists idx_facts_status on "${s}".facts(status);
create index if not exists idx_facts_scope on "${s}".facts(scope);
create index if not exists idx_facts_rank on "${s}".facts(scope, status, pinned desc, importance desc, updated_at desc);
create index if not exists idx_sessions_project on "${s}".sessions(project);
create index if not exists idx_sessions_created on "${s}".sessions(created_at);
create index if not exists idx_docs_status on "${s}".docs(status);
create index if not exists idx_docs_scope on "${s}".docs(scope);

create index if not exists idx_facts_tsv on "${s}".facts using gin(search_tsv);
create index if not exists idx_sessions_tsv on "${s}".sessions using gin(search_tsv);
create index if not exists idx_docs_tsv on "${s}".docs using gin(search_tsv);
`;
}
