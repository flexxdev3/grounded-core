/** SQLite schema. {{DIMS}} is replaced with the embedding dimensionality. */

export const SQLITE_BASE = `
create table if not exists facts (
  id integer primary key autoincrement,
  scope text not null default 'global',
  category text not null default '',
  fact text not null,
  detail text,
  topic_key text,
  pinned integer not null default 0,
  -- column default stays 0 (existing rows must not shift); the app-level
  -- default of 0.6 is applied in factsAdd (sqlite.ts), not here.
  importance real not null default 0,
  status text not null default 'active',
  -- 'stated' = written by an operator/agent that meant it (every current write
  -- path). 'derived' is reserved for Phase 8 synthesis, which must never be
  -- able to present its inferences as operator truth.
  origin text not null default 'stated' check (origin in ('stated', 'derived')),
  created_by text,
  source text,
  created_at text not null,
  updated_at text not null
);

create table if not exists sessions (
  id integer primary key autoincrement,
  machine text,
  project text,
  workspace text,
  agent text,
  summary text not null,
  details text,
  tags text,
  source text not null default 'manual',
  created_at text not null
);

create table if not exists docs (
  id integer primary key autoincrement,
  source text not null default 'default',
  path text not null,
  title text not null default '',
  body text not null,
  chunk_idx integer not null default 0,
  total_chunks integer not null default 1,
  body_hash text not null,
  mtime text,
  status text not null default 'active',
  kind text,
  machine text,
  scope text not null default 'global',
  project text,
  ingested_at text not null
);

create table if not exists vision (
  id integer primary key autoincrement,
  scope text not null default 'global',
  -- narrative markdown; recalled, never injected. Named 'details' from the
  -- start for cabinets created after the summary/details split (stage 2).
  -- Cabinets created before the split have a 'content' column instead --
  -- see migrateVisionSummarySplit() below, which renames it non-destructively.
  details text not null,
  -- short form injected at SessionStart; never recalled. Nullable -- falls
  -- back to truncated 'details' for injection when unset.
  summary text,
  created_by text,
  source text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_facts_status on facts(status);
create index if not exists idx_facts_scope on facts(scope);
create index if not exists idx_facts_topic on facts(topic_key);
create index if not exists idx_facts_rank on facts(scope, status, pinned desc, importance desc, updated_at desc);
create index if not exists idx_sessions_project on sessions(project);
create index if not exists idx_sessions_created on sessions(created_at);
create index if not exists idx_docs_path on docs(path);
create index if not exists idx_docs_status on docs(status);
create index if not exists idx_docs_scope on docs(scope);
create index if not exists idx_docs_project on docs(project);
create unique index if not exists idx_docs_path_chunk on docs(path, chunk_idx);
create unique index if not exists idx_vision_scope on vision(scope);
`;

export const SQLITE_FTS = `
create virtual table if not exists fts_facts using fts5(
  fact, detail, content='facts', content_rowid='id', tokenize='porter unicode61'
);
create virtual table if not exists fts_sessions using fts5(
  summary, details, content='sessions', content_rowid='id', tokenize='porter unicode61'
);
create virtual table if not exists fts_docs using fts5(
  title, body, content='docs', content_rowid='id', tokenize='porter unicode61'
);
`;

export function sqliteVecTables(dims: number): string {
  return `
create virtual table if not exists vec_facts using vec0(embedding float[${dims}]);
create virtual table if not exists vec_sessions using vec0(embedding float[${dims}]);
create virtual table if not exists vec_docs using vec0(embedding float[${dims}]);
`;
}
