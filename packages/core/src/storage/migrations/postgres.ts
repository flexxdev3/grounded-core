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

-- fact origin (stage 2b): every current write path is explicit operator/agent
-- input, so 'stated' is the correct default and backfill value for existing
-- rows. Reserved for Phase 8 synthesis, which must never be able to present
-- an inference as operator truth. IF NOT EXISTS guards the whole clause
-- (including the inline check) atomically -- on a cabinet that already has
-- the column this is a pure no-op, so re-running never touches the
-- constraint on an existing column. Same idiom as docs.scope above.
alter table "${s}".facts add column if not exists origin text not null default 'stated' check (origin in ('stated','derived'));

-- fact identity backfill (stage 2b), MUST run before idx_facts_topic_key below:
-- a cabinet that predates topicKey-uniqueness may already hold two or more
-- ACTIVE rows sharing a (scope, topic_key) -- creating the unique index first
-- would fail on that cabinet and break init(). Null the topic_key on every
-- row in a collision group except the newest (by updated_at, then id as a
-- deterministic tiebreak); the older rows survive untouched, just unkeyed --
-- never deleted, never merged. Archived rows are exempt (the index only
-- constrains status='active'), so an archived duplicate keeps its key.
-- Idempotent: once no group has more than one active row per key, this is a
-- zero-row UPDATE on every subsequent init().
update "${s}".facts f
set topic_key = null
where f.status = 'active' and f.topic_key is not null
  and f.id <> (
    select f2.id from "${s}".facts f2
    where f2.scope = f.scope and f2.topic_key = f.topic_key and f2.status = 'active'
    order by f2.updated_at desc, f2.id desc
    limit 1
  );

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
-- fact identity (stage 2b): makes factsAdd an upsert-in-place on (scope,
-- topic_key). Partial -- constrains ACTIVE rows only, so an archived row
-- never blocks a new active row with the same key, and a retired key can be
-- reused. Must run after the backfill above on a cabinet with pre-existing
-- collisions.
create unique index if not exists idx_facts_topic_key
  on "${s}".facts (scope, topic_key)
  where topic_key is not null and status = 'active';
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
