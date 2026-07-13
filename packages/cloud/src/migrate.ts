import type pg from "pg";
import type { CloudConfig } from "./config.js";

/**
 * Control-plane migration. Creates the accounts schema + our tables (cabinets,
 * api_tokens, usage). better-auth manages its own tables (user/session/account/
 * verification) on first boot via its Postgres adapter — we don't DDL those here.
 * Idempotent.
 */
export async function migrateControlPlane(pool: pg.Pool, cfg: CloudConfig): Promise<void> {
  const s = cfg.accountsSchema;
  await pool.query(`create schema if not exists "${s}";`);

  await pool.query(`
    create table if not exists "${s}".cabinets (
      id          text primary key,
      user_id     text not null,
      schema      text not null unique,
      plan        text not null default 'free',
      status      text not null default 'active',
      shard       text not null default 'ovh',
      created_at  timestamptz not null default now(),
      unique (user_id)
    );

    create table if not exists "${s}".api_tokens (
      id           text primary key,
      cabinet_id   text not null references "${s}".cabinets(id) on delete cascade,
      name         text not null,
      token_hash   text not null,
      prefix       text not null,
      scopes       text[] not null default array['read','write'],
      last_used_at timestamptz,
      created_at   timestamptz not null default now(),
      revoked_at   timestamptz
    );
    create index if not exists idx_api_tokens_cabinet on "${s}".api_tokens(cabinet_id);
    create index if not exists idx_api_tokens_prefix  on "${s}".api_tokens(prefix);

    create table if not exists "${s}".usage (
      cabinet_id   text not null references "${s}".cabinets(id) on delete cascade,
      facts        integer not null default 0,
      sessions     integer not null default 0,
      doc_chunks   integer not null default 0,
      bytes        bigint  not null default 0,
      captured_at  timestamptz not null default now(),
      primary key (cabinet_id, captured_at)
    );
  `);
}
