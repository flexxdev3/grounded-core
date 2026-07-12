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
  importance real not null default 0,
  status text not null default 'active',
  superseded_by bigint,
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
  ingested_at timestamptz not null default now(),
  embedding vector(${dims}),
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
  ) stored
);

create table if not exists "${s}".vision (
  id bigint generated always as identity primary key,
  scope text not null default 'global',
  content text not null,
  status text not null default 'active',
  superseded_by bigint,
  created_by text,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_docs_path_chunk on "${s}".docs(path, chunk_idx);
create unique index if not exists idx_vision_active on "${s}".vision(scope) where status = 'active';
create index if not exists idx_facts_status on "${s}".facts(status);
create index if not exists idx_facts_scope on "${s}".facts(scope);
create index if not exists idx_sessions_project on "${s}".sessions(project);
create index if not exists idx_sessions_created on "${s}".sessions(created_at);
create index if not exists idx_docs_status on "${s}".docs(status);

create index if not exists idx_facts_tsv on "${s}".facts using gin(search_tsv);
create index if not exists idx_sessions_tsv on "${s}".sessions using gin(search_tsv);
create index if not exists idx_docs_tsv on "${s}".docs using gin(search_tsv);
`;
}
