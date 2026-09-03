import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { IngestPathError, StoreError } from "../contract.js";
import type {
  BriefOptions,
  BriefResult,
  DeliveryMeta,
  Doc,
  DocStatus,
  EmbeddingProvider,
  Fact,
  FactInput,
  FactOrigin,
  FactStatus,
  FullRecord,
  GroundedConfig,
  HealthReport,
  ImpactOptions,
  ImpactResult,
  IngestOptions,
  IngestReport,
  ListOptions,
  ListResult,
  RecallOptions,
  RecallResult,
  Session,
  SessionInput,
  SourceType,
  Store,
  TimelineOptions,
  TypedId,
  Vision,
  VisionInput,
} from "../contract.js";
import {
  applyLaneFloor,
  DOC_LANE_FLOOR,
  fuseLane,
  orderResults,
  rankFlat,
  lexicalMeta,
  recallFactScopes,
  scopeFilterMeta,
  withEffectiveSourceCaps,
  type CandidateMeta,
  type RecallContext,
  type FusedItem,
  type LaneHit,
  type LexicalMode,
  type SessionFilter,
  embedQueryText,
} from "../engine/recall.js";

/** doc vector-lane over-fetch factor when a scope filter is in play — see
 * `vectorLane`. 5x is sized so a lane holding ~a fifth of the corpus still
 * fills the window; it is a mitigation for sqlite-vec's pre-join `k`, not a
 * guarantee. */
const VEC_SCOPE_OVERFETCH = 5;
import {
  assembleBrief,
  deriveFactScopes,
  deriveDocScopes,
  fillRelatedDocs,
} from "../engine/brief.js";
import { walk } from "../ingest/walker.js";
import { stripPrivateBlocks } from "../ingest/private.js";
import { splitFrontmatter, parseFrontmatterTags } from "../ingest/frontmatter.js";
import { chunkText, deriveTitle } from "../ingest/chunk.js";
import { projectFromPath } from "../ingest/project.js";
import { isReadableDir } from "../ingest/walker.js";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * FTS5 MATCH-safe query: quote each token, join them by the requested mode.
 *
 * `strict` ANDs the terms (the query as written), `relaxed` ORs them. Both
 * forms exist so this adapter can run the SAME strict-then-fallback policy as
 * postgres — see `lexicalLane`. Before that policy the two adapters silently
 * disagreed on the same query: sqlite ALWAYS OR-ed, postgres' websearch parser
 * always ANDs, so a two-word query was broad here and empty there.
 */
function sanitizeFts(query: string, mode: LexicalMode = "strict"): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(mode === "strict" ? " AND " : " OR ");
}

export class SqliteStore implements Store {
  private db: Database.Database;
  private vectorEnabled = false;
  private readonly dims: number;

  constructor(
    private readonly cfg: GroundedConfig,
    private readonly embedder: EmbeddingProvider,
  ) {
    const path = cfg.storage.path;
    if (!path) throw new StoreError("sqlite adapter requires storage.path");
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.dims = embedder.enabled ? embedder.dims : (cfg.embeddings.dims ?? 768);
  }

  async init(): Promise<void> {
    const { SQLITE_BASE, SQLITE_FTS, sqliteVecTables } = await import(
      "./migrations/sqlite.js"
    );
    this.db.exec(SQLITE_BASE);
    this.db.exec(SQLITE_FTS);
    this.migrateDropVisionStatus();
    this.migrateAddDocsScope();
    this.migrateAddDocsProject();
    this.migrateVisionSummarySplit();
    this.migrateAddFactsOrigin();
    this.migrateFactsTopicKeyIdentity();

    if (this.embedder.enabled) {
      try {
        sqliteVec.load(this.db);
        this.db.exec(sqliteVecTables(this.dims));
        this.vectorEnabled = true;
      } catch {
        this.vectorEnabled = false;
      }
    } else {
      this.vectorEnabled = false;
    }
  }

  /**
   * One-shot migration for cabinets created before vision went in-place-only:
   * drop the vestigial `status` column (SQLite has no DROP COLUMN IF EXISTS).
   */
  private migrateDropVisionStatus(): void {
    const hasStatus = this.db
      .prepare(`select 1 from pragma_table_info('vision') where name = 'status'`)
      .get();
    if (!hasStatus) return;
    this.db.exec(
      `drop index if exists idx_vision_active;
       alter table vision drop column status;
       create unique index if not exists idx_vision_scope on vision(scope);`,
    );
  }

  /**
   * One-shot migration for cabinets created before docs.scope existed (stage 3).
   * SQLite has no ADD COLUMN IF NOT EXISTS, so probe pragma_table_info first.
   */
  private migrateAddDocsScope(): void {
    const hasScope = this.db
      .prepare(`select 1 from pragma_table_info('docs') where name = 'scope'`)
      .get();
    if (hasScope) return;
    this.db.exec(
      `alter table docs add column scope text not null default 'global';
       create index if not exists idx_docs_scope on docs(scope);`,
    );
  }

  /**
   * One-shot migration for cabinets created before docs.project existed
   * (stage 4). SQLite has no ADD COLUMN IF NOT EXISTS, so probe
   * pragma_table_info first. Nullable, no default -- unlike scope, an
   * unknown project must stay NULL rather than backfilling to a guessed
   * value.
   */
  private migrateAddDocsProject(): void {
    const hasProject = this.db
      .prepare(`select 1 from pragma_table_info('docs') where name = 'project'`)
      .get();
    if (hasProject) return;
    this.db.exec(
      `alter table docs add column project text;
       create index if not exists idx_docs_project on docs(project);`,
    );
  }

  /**
   * One-shot migration for cabinets created before the vision summary/details
   * split (stage 2): rename `content` -> `details`, then separately add a
   * nullable `summary` column if absent. Non-destructive — never drops data,
   * never deletes a row. `alter table ... rename column` requires SQLite
   * >= 3.25; better-sqlite3 bundles a modern build so this is safe.
   */
  private migrateVisionSummarySplit(): void {
    const hasContent = this.db
      .prepare(`select 1 from pragma_table_info('vision') where name = 'content'`)
      .get();
    if (hasContent) {
      this.db.exec(`alter table vision rename column content to details;`);
    }
    const hasSummary = this.db
      .prepare(`select 1 from pragma_table_info('vision') where name = 'summary'`)
      .get();
    if (!hasSummary) {
      this.db.exec(`alter table vision add column summary text;`);
    }
  }

  /**
   * One-shot migration for cabinets created before facts.origin existed
   * (stage 2b). SQLite has no ADD COLUMN IF NOT EXISTS, so probe
   * pragma_table_info first. The CHECK constraint is enforced by SQLite on
   * ADD COLUMN as long as the default value ('stated') satisfies it, which it
   * does — every existing row backfills to 'stated', the correct value since
   * every current write path is explicit operator/agent input.
   */
  private migrateAddFactsOrigin(): void {
    const hasOrigin = this.db
      .prepare(`select 1 from pragma_table_info('facts') where name = 'origin'`)
      .get();
    if (hasOrigin) return;
    this.db.exec(
      `alter table facts add column origin text not null default 'stated' check (origin in ('stated', 'derived'));`,
    );
  }

  /**
   * One-shot migration for cabinets created before facts had an identity
   * constraint (stage 2b): backfill any pre-existing (scope, topic_key)
   * collisions among active rows, then create the partial unique index that
   * makes factsAdd an upsert going forward.
   *
   * Non-destructive: NEVER deletes a row, NEVER merges two rows' content.
   * For each collision group, the newest row keeps its topic_key — newest by
   * `updated_at desc, id desc`, i.e. most recently edited, with id breaking
   * the millisecond ties that rapid writes can produce. Every older row in
   * the group is nulled on topic_key only, so it survives intact and simply
   * loses its identity key. An operator can re-key it deliberately later.
   *
   * Guarded on the index's own existence (not a column probe, since this
   * migrates an index, not a column) so it runs exactly once per cabinet —
   * idempotent by construction, and init() re-running it on every open is
   * therefore cheap after the first run. The live homelab cabinet (24 facts,
   * already unique per scope) is a no-op here; the migration still had to be
   * verified against a cabinet that does collide (see stage report).
   */
  private migrateFactsTopicKeyIdentity(): void {
    const hasIndex = this.db
      .prepare(`select 1 from pragma_index_list('facts') where name = 'idx_facts_topic_active_unique'`)
      .get();
    if (hasIndex) return;
    this.db.exec(
      // "Newest" = most recently EDITED, with id as the tiebreak: the row an
      // operator touched last is the live one. Ordering by id alone would keep
      // an untouched early row over a later-curated one. Must stay identical to
      // the postgres backfill's `order by updated_at desc, id desc`.
      `update facts
       set topic_key = null
       where status = 'active'
         and topic_key is not null
         and id not in (
           select f2.id from facts f2
           where f2.status = 'active' and f2.topic_key is not null
             and f2.scope = facts.scope and f2.topic_key = facts.topic_key
           order by f2.updated_at desc, f2.id desc
           limit 1
         );`,
    );
    this.db.exec(
      `create unique index if not exists idx_facts_topic_active_unique
       on facts(scope, topic_key)
       where topic_key is not null and status = 'active';`,
    );
  }

  private vectorActive(): boolean {
    return this.vectorEnabled && this.embedder.enabled;
  }

  private async embedOne(text: string): Promise<number[] | null> {
    if (!this.vectorActive()) return null;
    const vecs = await this.embedder.embed([text]);
    const v = vecs[0];
    if (!v || v.length === 0) return null;
    return v;
  }

  private upsertVector(table: string, id: number, vec: number[]): void {
    if (!this.vectorActive()) return;
    this.db.prepare(`delete from ${table} where rowid = ?`).run(BigInt(id));
    this.db
      .prepare(`insert into ${table}(rowid, embedding) values (?, ?)`)
      .run(BigInt(id), JSON.stringify(vec));
  }

  private deleteVector(table: string, id: number): void {
    if (!this.vectorEnabled) return;
    try {
      this.db.prepare(`delete from ${table} where rowid = ?`).run(BigInt(id));
    } catch {
      // table may not exist when vectors disabled.
    }
  }

  // ---- facts -------------------------------------------------------------

  private rowToFact(r: Row): Fact {
    return {
      id: Number(r.id),
      scope: String(r.scope),
      category: String(r.category),
      fact: String(r.fact),
      detail: (r.detail as string | null) ?? null,
      topicKey: (r.topic_key as string | null) ?? null,
      pinned: Number(r.pinned) === 1,
      importance: Number(r.importance),
      status: String(r.status) as FactStatus,
      origin: String(r.origin) as FactOrigin,
      createdBy: (r.created_by as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async factsAdd(input: FactInput): Promise<Fact> {
    const scope = input.scope ?? "global";
    // Identity contract (Fact.topicKey's JSDoc): unique per scope among ACTIVE
    // rows. Writing the same (scope, topicKey) edits that row in place instead
    // of racing the partial unique index into a constraint error — dedup on
    // write, never a second row, never a supersede chain (d20bbb3 stands).
    // Archived rows are exempt from the lookup (and the index), so a retired
    // key never blocks a fresh active fact from claiming it.
    //
    // The `status === "active"` guard is load-bearing, not defensive. Without
    // it, adding an ARCHIVED fact whose key an ACTIVE row already holds would
    // find that active row and route the write through factsUpdate — silently
    // overwriting an unrelated live fact's text and archiving it, with a 200
    // and no signal. Adding a non-active row cannot collide, because the
    // partial unique index only constrains active rows; it is a plain insert.
    if (input.topicKey && (input.status ?? "active") === "active") {
      const existing = this.db
        .prepare(`select id from facts where scope = ? and topic_key = ? and status = 'active'`)
        .get(scope, input.topicKey) as Row | undefined;
      if (existing) {
        return this.factsUpdate(Number(existing.id), input);
      }
    }
    const ts = nowIso();
    const info = this.db
      .prepare(
        `insert into facts(scope, category, fact, detail, topic_key, pinned, importance, status, origin, created_by, source, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope,
        input.category ?? "",
        input.fact,
        input.detail ?? null,
        input.topicKey ?? null,
        input.pinned ? 1 : 0,
        // default 0.6, not the column's DDL default of 0: feeds `pinned desc,
        // importance desc, updated_at desc` ordering in factsList — a fact
        // written with no explicit importance should tie the unpinned cluster,
        // not sort dead last.
        input.importance ?? 0.6,
        input.status ?? "active",
        input.origin ?? "stated",
        input.createdBy ?? null,
        input.source ?? null,
        ts,
        ts,
      );
    const id = Number(info.lastInsertRowid);
    this.db
      .prepare(`insert into fts_facts(rowid, fact, detail) values (?, ?, ?)`)
      .run(id, input.fact, input.detail ?? null);
    const vec = await this.embedOne(`${input.fact}\n${input.detail ?? ""}`.trim());
    if (vec) this.upsertVector("vec_facts", id, vec);
    const fact = await this.factsGet(id);
    if (!fact) throw new StoreError("failed to read inserted fact");
    return fact;
  }

  async factsList(opts?: ListOptions): Promise<ListResult<Fact>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.scopes && opts.scopes.length > 0) {
      where.push(`scope in (${opts.scopes.map(() => "?").join(", ")})`);
      params.push(...opts.scopes);
    } else if (opts?.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(
        `select * from facts ${whereSql} order by pinned desc, importance desc, updated_at desc limit ? offset ?`,
      )
      .all(...params, limit, offset) as Row[];
    const available = Number(
      (this.db.prepare(`select count(*) as c from facts ${whereSql}`).get(...params) as Row).c,
    );
    const returned = rows.length;
    const meta: DeliveryMeta = {
      returned,
      available,
      truncated: offset + returned < available,
      limit,
    };
    return { data: rows.map((r) => this.rowToFact(r)), meta };
  }

  async factsGet(id: number): Promise<Fact | null> {
    const r = this.db.prepare(`select * from facts where id = ?`).get(id) as
      | Row
      | undefined;
    return r ? this.rowToFact(r) : null;
  }

  async factsDelete(id: number): Promise<boolean> {
    const info = this.db.prepare(`delete from facts where id = ?`).run(id);
    if (info.changes > 0) {
      this.db.prepare(`delete from fts_facts where rowid = ?`).run(id);
      this.deleteVector("vec_facts", id);
      return true;
    }
    return false;
  }

  async factsUpdate(id: number, patch: Partial<FactInput>): Promise<Fact> {
    const existing = await this.factsGet(id);
    if (!existing) throw new StoreError(`fact ${id} not found`);
    const next = {
      scope: patch.scope ?? existing.scope,
      category: patch.category ?? existing.category,
      fact: patch.fact ?? existing.fact,
      detail: patch.detail !== undefined ? patch.detail : existing.detail,
      topicKey: patch.topicKey !== undefined ? patch.topicKey : existing.topicKey,
      pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
      importance: patch.importance !== undefined ? patch.importance : existing.importance,
      status: patch.status !== undefined ? patch.status : existing.status,
      origin: patch.origin !== undefined ? patch.origin : existing.origin,
      source: patch.source !== undefined ? patch.source : existing.source,
      createdBy: patch.createdBy !== undefined ? patch.createdBy : existing.createdBy,
    };
    const textChanged = next.fact !== existing.fact || (next.detail ?? "") !== (existing.detail ?? "");
    if (textChanged) {
      // External-content FTS5: retire the old index entry using the OLD values
      // (the 'delete' command) BEFORE the base row changes, then insert the new one.
      this.db
        .prepare(`insert into fts_facts(fts_facts, rowid, fact, detail) values ('delete', ?, ?, ?)`)
        .run(id, existing.fact, existing.detail ?? null);
    }
    try {
      this.db
        .prepare(
          `update facts set scope = ?, category = ?, fact = ?, detail = ?, topic_key = ?, pinned = ?, importance = ?, status = ?, origin = ?, source = ?, created_by = ?, updated_at = ? where id = ?`,
        )
        .run(
          next.scope,
          next.category,
          next.fact,
          next.detail ?? null,
          next.topicKey ?? null,
          next.pinned ? 1 : 0,
          next.importance,
          next.status,
          next.origin,
          next.source ?? null,
          next.createdBy ?? null,
          nowIso(),
          id,
        );
    } catch (err) {
      // The partial unique index only constrains ACTIVE rows with a topicKey.
      // factsAdd's upsert lookup prevents this on the write path it controls,
      // but a direct factsUpdate can still ask to (a) rename topicKey to one
      // another active fact already holds, or (b) un-archive a fact back into
      // a key an active fact has since claimed. Both are genuinely ambiguous —
      // silently overwriting or silently dropping the key would hide operator
      // intent — so this fails loudly with a resolvable message rather than
      // duplicating a row or clobbering the other fact.
      if (
        err instanceof Error &&
        /unique constraint failed/i.test(err.message) &&
        /topic_key/i.test(err.message)
      ) {
        throw new StoreError(
          `cannot set fact ${id} active with topicKey "${next.topicKey}" in scope "${next.scope}" — ` +
            `another active fact already holds that key; archive or re-key it first`,
        );
      }
      throw err;
    }
    if (textChanged) {
      this.db
        .prepare(`insert into fts_facts(rowid, fact, detail) values (?, ?, ?)`)
        .run(id, next.fact, next.detail ?? null);
      const vec = await this.embedOne(`${next.fact}\n${next.detail ?? ""}`.trim());
      if (vec) this.upsertVector("vec_facts", id, vec);
    }
    const fact = await this.factsGet(id);
    if (!fact) throw new StoreError("failed to read updated fact");
    return fact;
  }

  async factsDeliveryRank(id: number): Promise<{ rank: number; ofActive: number } | null> {
    const fact = await this.factsGet(id);
    if (!fact || fact.status !== "active") return null;
    const row = this.db
      .prepare(
        // Self-join against the row's own column values rather than binding a
        // round-tripped copy — keeps this identical in shape to the postgres
        // adapter, where re-serializing the timestamp loses precision and makes
        // a fact outrank itself.
        `select 1 + sum(case when a.id <> f.id
                              and (a.pinned > f.pinned
                                or (a.pinned = f.pinned and a.importance > f.importance)
                                or (a.pinned = f.pinned and a.importance = f.importance
                                    and a.updated_at > f.updated_at))
                             then 1 else 0 end) as rank,
                count(*) as of_active
         from facts a
         cross join (select id, pinned, importance, updated_at from facts where id = ?) f
         where a.scope = ? and a.status = 'active'`,
      )
      .get(id, fact.scope) as Row;
    return { rank: Number(row.rank), ofActive: Number(row.of_active) };
  }

  // ---- vision --------------------------------------------------------------
  // One active record per scope; edited in place; excluded from recall (no FTS/vec rows).

  private rowToVision(r: Row): Vision {
    return {
      id: Number(r.id),
      scope: String(r.scope),
      summary: (r.summary as string | null) ?? null,
      details: String(r.details),
      createdBy: (r.created_by as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async visionGet(scope: string): Promise<Vision | null> {
    const r = this.db
      .prepare(`select * from vision where scope = ?`)
      .get(scope) as Row | undefined;
    return r ? this.rowToVision(r) : null;
  }

  async visionList(opts?: ListOptions): Promise<ListResult<Vision>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(`select * from vision ${whereSql} order by updated_at desc limit ? offset ?`)
      .all(...params, limit, offset) as Row[];
    const available = Number(
      (this.db.prepare(`select count(*) as c from vision ${whereSql}`).get(...params) as Row).c,
    );
    const returned = rows.length;
    const meta: DeliveryMeta = {
      returned,
      available,
      truncated: offset + returned < available,
      limit,
    };
    return { data: rows.map((r) => this.rowToVision(r)), meta };
  }

  async visionSet(input: VisionInput): Promise<Vision> {
    const scope = input.scope ?? "global";
    const ts = nowIso();
    const run = this.db.transaction(() => {
      const prior = this.db
        .prepare(`select id from vision where scope = ?`)
        .get(scope) as Row | undefined;
      // exactly one record per scope — edit it in place, or insert if none exists.
      if (prior) {
        this.db
          .prepare(`update vision set details = ?, summary = ?, source = ?, updated_at = ? where id = ?`)
          .run(input.details, input.summary ?? null, input.source ?? null, ts, Number(prior.id));
        return Number(prior.id);
      }
      const info = this.db
        .prepare(
          `insert into vision(scope, details, summary, created_by, source, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope,
          input.details,
          input.summary ?? null,
          input.createdBy ?? null,
          input.source ?? null,
          ts,
          ts,
        );
      return Number(info.lastInsertRowid);
    });
    const id = run();
    const r = this.db.prepare(`select * from vision where id = ?`).get(id) as Row | undefined;
    if (!r) throw new StoreError("failed to read inserted vision");
    return this.rowToVision(r);
  }

  async visionDelete(id: number): Promise<boolean> {
    const info = this.db.prepare(`delete from vision where id = ?`).run(id);
    return info.changes > 0;
  }

  // ---- sessions ----------------------------------------------------------

  private rowToSession(r: Row): Session {
    const tagsRaw = r.tags as string | null;
    return {
      id: Number(r.id),
      machine: (r.machine as string | null) ?? null,
      project: (r.project as string | null) ?? null,
      workspace: (r.workspace as string | null) ?? null,
      agent: (r.agent as string | null) ?? null,
      summary: String(r.summary),
      details: (r.details as string | null) ?? null,
      tags: tagsRaw ? (JSON.parse(tagsRaw) as string[]) : null,
      source: String(r.source),
      createdAt: String(r.created_at),
    };
  }

  async sessionsAdd(input: SessionInput): Promise<Session> {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `insert into sessions(machine, project, workspace, agent, summary, details, tags, source, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.machine ?? null,
        input.project ?? null,
        input.workspace ?? null,
        input.agent ?? null,
        input.summary,
        input.details ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.source ?? "manual",
        ts,
      );
    const id = Number(info.lastInsertRowid);
    this.db
      .prepare(`insert into fts_sessions(rowid, summary, details) values (?, ?, ?)`)
      .run(id, input.summary, input.details ?? null);
    const vec = await this.embedOne(
      `${input.summary}\n${input.details ?? ""}`.trim(),
    );
    if (vec) this.upsertVector("vec_sessions", id, vec);
    const s = await this.sessionsGet(id);
    if (!s) throw new StoreError("failed to read inserted session");
    return s;
  }

  async sessionsList(opts?: ListOptions): Promise<ListResult<Session>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.project) {
      where.push("project = ?");
      params.push(opts.project);
    }
    if (opts?.workspace) {
      where.push("workspace = ?");
      params.push(opts.workspace);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(
        `select * from sessions ${whereSql} order by created_at desc, id desc limit ? offset ?`,
      )
      .all(...params, limit, offset) as Row[];
    const available = Number(
      (this.db.prepare(`select count(*) as c from sessions ${whereSql}`).get(...params) as Row).c,
    );
    const returned = rows.length;
    const meta: DeliveryMeta = {
      returned,
      available,
      truncated: offset + returned < available,
      limit,
    };
    return { data: rows.map((r) => this.rowToSession(r)), meta };
  }

  async sessionsGet(id: number): Promise<Session | null> {
    const r = this.db.prepare(`select * from sessions where id = ?`).get(id) as
      | Row
      | undefined;
    return r ? this.rowToSession(r) : null;
  }

  async sessionsUpdate(id: number, patch: Partial<SessionInput>): Promise<Session> {
    const existing = await this.sessionsGet(id);
    if (!existing) throw new StoreError(`session ${id} not found`);
    const next = {
      summary: patch.summary ?? existing.summary,
      details: patch.details !== undefined ? patch.details : existing.details,
      project: patch.project !== undefined ? patch.project : existing.project,
      workspace: patch.workspace !== undefined ? patch.workspace : existing.workspace,
      agent: patch.agent !== undefined ? patch.agent : existing.agent,
      machine: patch.machine !== undefined ? patch.machine : existing.machine,
      tags: patch.tags !== undefined ? patch.tags : existing.tags,
      source: patch.source !== undefined ? patch.source : existing.source,
    };
    const textChanged =
      next.summary !== existing.summary ||
      (next.details ?? "") !== (existing.details ?? "");
    if (textChanged) {
      // External-content FTS5: retire the old entry with the OLD values before
      // the base row changes (same discipline as factsUpdate/sessionsDelete).
      this.db
        .prepare(
          `insert into fts_sessions(fts_sessions, rowid, summary, details) values ('delete', ?, ?, ?)`,
        )
        .run(id, existing.summary, existing.details ?? null);
    }
    this.db
      .prepare(
        `update sessions set summary = ?, details = ?, project = ?, workspace = ?, agent = ?, machine = ?, tags = ?, source = ? where id = ?`,
      )
      .run(
        next.summary,
        next.details ?? null,
        next.project ?? null,
        next.workspace ?? null,
        next.agent ?? null,
        next.machine ?? null,
        next.tags ? JSON.stringify(next.tags) : null,
        next.source ?? null,
        id,
      );
    if (textChanged) {
      this.db
        .prepare(`insert into fts_sessions(rowid, summary, details) values (?, ?, ?)`)
        .run(id, next.summary, next.details ?? null);
      const vec = await this.embedOne(`${next.summary}\n${next.details ?? ""}`.trim());
      if (vec) this.upsertVector("vec_sessions", id, vec);
    }
    const s = await this.sessionsGet(id);
    if (!s) throw new StoreError("failed to read updated session");
    return s;
  }

  async sessionsDelete(id: number): Promise<boolean> {
    // fts_sessions is an external-content FTS5 table: the index row must be
    // retired with the 'delete' command carrying the OLD column values, and
    // BEFORE the base row goes away — a plain `delete from fts_...` leaves a
    // stale rowid behind that recall then fails to hydrate.
    const row = this.db
      .prepare(`select summary, details from sessions where id = ?`)
      .get(id) as Row | undefined;
    if (!row) return false;
    this.db
      .prepare(
        `insert into fts_sessions(fts_sessions, rowid, summary, details) values ('delete', ?, ?, ?)`,
      )
      .run(id, row.summary ?? "", row.details ?? "");
    this.db.prepare(`delete from sessions where id = ?`).run(id);
    this.deleteVector("vec_sessions", id);
    return true;
  }

  async sessionsTimeline(opts: TimelineOptions): Promise<Session[]> {
    const window = opts.window ?? 5;
    if (opts.around != null) {
      const anchor = this.db
        .prepare(`select created_at from sessions where id = ?`)
        .get(opts.around) as Row | undefined;
      if (!anchor) return [];
      const before = this.db
        .prepare(
          `select * from sessions where created_at <= ? and id != ? order by created_at desc, id desc limit ?`,
        )
        .all(String(anchor.created_at), opts.around, window) as Row[];
      const self = this.db
        .prepare(`select * from sessions where id = ?`)
        .get(opts.around) as Row;
      const after = this.db
        .prepare(
          `select * from sessions where created_at > ? order by created_at asc, id asc limit ?`,
        )
        .all(String(anchor.created_at), window) as Row[];
      const all = [...before.reverse(), self, ...after];
      return all.map((r) => this.rowToSession(r));
    }
    if (opts.query) {
      const results = await this.recall(opts.query, {
        sources: ["session"],
        project: opts.project,
        limit: window,
      });
      const ids = results.data.map((r) => r.id);
      const out: Session[] = [];
      for (const id of ids) {
        const s = await this.sessionsGet(id);
        if (s) out.push(s);
      }
      return out;
    }
    return (await this.sessionsList({ project: opts.project, limit: window })).data;
  }

  // ---- docs --------------------------------------------------------------

  private rowToDoc(r: Row): Doc {
    return {
      id: Number(r.id),
      source: String(r.source),
      path: String(r.path),
      title: String(r.title),
      body: String(r.body),
      chunkIdx: Number(r.chunk_idx),
      totalChunks: Number(r.total_chunks),
      bodyHash: String(r.body_hash),
      mtime: (r.mtime as string | null) ?? null,
      status: String(r.status) as DocStatus,
      kind: (r.kind as string | null) ?? null,
      machine: (r.machine as string | null) ?? null,
      scope: String(r.scope),
      project: (r.project as string | null) ?? null,
      ingestedAt: String(r.ingested_at),
    };
  }

  async docsIngest(rootPaths: string[], opts?: IngestOptions): Promise<IngestReport> {
    const report: IngestReport = {
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      retagged: 0,
      removed: 0,
      paths: [],
    };
    const source = opts?.source ?? "default";
    const kind = opts?.kind ?? "markdown";
    const machine = opts?.machine ?? null;
    // batch scope is a DEFAULT, not an override: a file that declares its own
    // `scope:` in frontmatter wins, and the disagreement is reported. See
    // IngestReport.frontmatterOverrides.
    const batchScope = opts?.scope ?? "global";
    const overrides: NonNullable<IngestReport["frontmatterOverrides"]> = [];
    report.frontmatterOverrides = overrides;
    const dryRun = opts?.dryRun ?? false;
    const stripPrivate = this.cfg.ingest.stripPrivate;
    const stripFrontmatterFlag = this.cfg.ingest.stripFrontmatter;
    const ignoreFile = this.cfg.ingest.ignoreFile;
    const unreadable = rootPaths.filter((p) => !isReadableDir(p));
    if (unreadable.length > 0) throw new IngestPathError(unreadable);

    for (const root of rootPaths) {
      const files = walk(root, ignoreFile);
      for (const file of files) {
        report.scanned++;
        let raw: string;
        try {
          raw = readFileSync(file.absPath, "utf8");
        } catch {
          continue;
        }
        const stripped = stripPrivate ? stripPrivateBlocks(raw) : raw;
        // frontmatter is ALWAYS split for its tags, even when the configured
        // ingest keeps it in the indexed body.
        const split = splitFrontmatter(stripped);
        const fmTags = parseFrontmatterTags(split.frontmatter);
        const content = stripFrontmatterFlag ? split.body : stripped;
        const title = deriveTitle(content, file.relPath);
        const chunks = chunkText(
          content,
          this.cfg.ingest.chunkChars,
          this.cfg.ingest.chunkOverlap,
        );
        if (chunks.length === 0) continue;
        const mtime = new Date(file.mtimeMs).toISOString();
        const docPath = file.absPath;
        const dirProject =
          opts?.project ?? projectFromPath(docPath, this.cfg.ingest.projectSegment);
        const project = fmTags.project ?? dirProject;
        const scope = fmTags.scope ?? batchScope;
        if (fmTags.scope && fmTags.scope !== batchScope) {
          overrides.push({
            path: docPath,
            field: "scope",
            frontmatter: fmTags.scope,
            batch: batchScope,
          });
        }
        if (fmTags.project && dirProject && fmTags.project !== dirProject) {
          overrides.push({
            path: docPath,
            field: "project",
            frontmatter: fmTags.project,
            batch: dirProject,
          });
        }

        const existing = this.db
          .prepare(`select id, chunk_idx, body_hash, source, kind, machine, scope, project from docs where path = ?`)
          .all(docPath) as Row[];
        const existingByIdx = new Map<number, Row>();
        for (const e of existing) existingByIdx.set(Number(e.chunk_idx), e);

        let fileTouched = false;
        for (const chunk of chunks) {
          const prev = existingByIdx.get(chunk.idx);
          if (prev && String(prev.body_hash) === chunk.bodyHash) {
            // body unchanged — but the batch tags (source/kind/machine/scope/
            // project) may have shifted (e.g. a re-tag ingest to move a tree
            // into a new lane, or a backfill of the project column added
            // after this row was first ingested). Compare and, if any
            // differ, run a tag-only UPDATE (no body/hash/total_chunks/
            // embedding touched) so retagging an unchanged file is not a
            // silent no-op.
            const tagsChanged =
              String(prev.source) !== source ||
              String(prev.kind ?? "") !== (kind ?? "") ||
              String(prev.machine ?? "") !== (machine ?? "") ||
              String(prev.scope) !== scope ||
              (prev.project ?? null) !== (project ?? null);
            if (tagsChanged) {
              if (!dryRun) {
                this.db
                  .prepare(
                    `update docs set source=?, kind=?, machine=?, scope=?, project=?, ingested_at=? where id=?`,
                  )
                  .run(source, kind, machine, scope, project, nowIso(), Number(prev.id));
              }
              report.retagged++;
            } else {
              report.skipped++;
            }
            existingByIdx.delete(chunk.idx);
            continue;
          }
          fileTouched = true;
          if (dryRun) {
            if (prev) report.updated++;
            else report.added++;
            existingByIdx.delete(chunk.idx);
            continue;
          }
          const ingestedAt = nowIso();
          if (prev) {
            const id = Number(prev.id);
            this.db
              .prepare(
                `update docs set source=?, title=?, body=?, total_chunks=?, body_hash=?, mtime=?, status='active', kind=?, machine=?, scope=?, project=?, ingested_at=? where id=?`,
              )
              .run(
                source,
                title,
                chunk.body,
                chunks.length,
                chunk.bodyHash,
                mtime,
                kind,
                machine,
                scope,
                project,
                ingestedAt,
                id,
              );
            this.db.prepare(`delete from fts_docs where rowid = ?`).run(id);
            this.db
              .prepare(`insert into fts_docs(rowid, title, body) values (?, ?, ?)`)
              .run(id, title, chunk.body);
            const vec = await this.embedOne(chunk.body);
            if (vec) this.upsertVector("vec_docs", id, vec);
            report.updated++;
          } else {
            const info = this.db
              .prepare(
                `insert into docs(source, path, title, body, chunk_idx, total_chunks, body_hash, mtime, status, kind, machine, scope, project, ingested_at)
                 values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
              )
              .run(
                source,
                docPath,
                title,
                chunk.body,
                chunk.idx,
                chunks.length,
                chunk.bodyHash,
                mtime,
                kind,
                machine,
                scope,
                project,
                ingestedAt,
              );
            const id = Number(info.lastInsertRowid);
            this.db
              .prepare(`insert into fts_docs(rowid, title, body) values (?, ?, ?)`)
              .run(id, title, chunk.body);
            const vec = await this.embedOne(chunk.body);
            if (vec) this.upsertVector("vec_docs", id, vec);
            report.added++;
          }
          existingByIdx.delete(chunk.idx);
        }

        // leftover chunks (file shrank) -> remove
        for (const [, leftover] of existingByIdx) {
          fileTouched = true;
          const id = Number(leftover.id);
          if (!dryRun) {
            this.db.prepare(`delete from docs where id = ?`).run(id);
            this.db.prepare(`delete from fts_docs where rowid = ?`).run(id);
            this.deleteVector("vec_docs", id);
          }
          report.removed++;
        }

        if (fileTouched) report.paths.push(docPath);
      }
    }
    return report;
  }

  async docsList(opts?: ListOptions): Promise<ListResult<Doc>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.source) {
      where.push("source = ?");
      params.push(opts.source);
    }
    if (opts?.scopes && opts.scopes.length > 0) {
      where.push(`scope in (${opts.scopes.map(() => "?").join(", ")})`);
      params.push(...opts.scopes);
    } else if (opts?.scope) {
      where.push("scope = ?");
      params.push(opts.scope);
    }
    if (opts?.documents) where.push("chunk_idx = 0");
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(
        `select * from docs ${whereSql} order by path asc, chunk_idx asc limit ? offset ?`,
      )
      .all(...params, limit, offset) as Row[];
    const available = Number(
      (this.db.prepare(`select count(*) as c from docs ${whereSql}`).get(...params) as Row).c,
    );
    const returned = rows.length;
    const meta: DeliveryMeta = {
      returned,
      available,
      truncated: offset + returned < available,
      limit,
    };
    return { data: rows.map((r) => this.rowToDoc(r)), meta };
  }

  async docsGet(id: number): Promise<Doc | null> {
    const r = this.db.prepare(`select * from docs where id = ?`).get(id) as
      | Row
      | undefined;
    return r ? this.rowToDoc(r) : null;
  }

  async docsPrune(opts?: { remove?: boolean }): Promise<{
    missing: number;
    removed: number;
  }> {
    const rows = this.db
      .prepare(`select distinct path from docs`)
      .all() as Row[];
    let missing = 0;
    let removed = 0;
    for (const r of rows) {
      const path = String(r.path);
      if (!existsSync(path)) {
        if (opts?.remove) {
          const ids = this.db
            .prepare(`select id from docs where path = ?`)
            .all(path) as Row[];
          for (const idRow of ids) {
            const id = Number(idRow.id);
            this.db.prepare(`delete from docs where id = ?`).run(id);
            this.db.prepare(`delete from fts_docs where rowid = ?`).run(id);
            this.deleteVector("vec_docs", id);
            removed++;
          }
        } else {
          const info = this.db
            .prepare(`update docs set status = 'missing' where path = ?`)
            .run(path);
          missing += info.changes;
        }
      }
    }
    return { missing, removed };
  }

  // ---- recall ------------------------------------------------------------

  /**
   * Run the lexical lane under the shared strict-then-relaxed policy.
   *
   * `strictExpr` is the query as written (terms ANDed). Only when it matches
   * NOTHING is `relaxedExpr` (terms ORed) tried, so a precise match is never
   * diluted, and a natural-language query that satisfies no row in full still
   * anchors the ranking on its rare terms instead of leaving it to the ANN lane.
   */
  private lexicalLaneWithFallback(
    ftsTable: string,
    mainTable: string,
    strictExpr: string,
    relaxedExpr: string,
    filter: SessionFilter | undefined,
    limit: number,
    laneScopes?: string[],
  ): { hits: LaneHit[]; relaxed: boolean } {
    const strict = this.lexicalLane(ftsTable, mainTable, strictExpr, filter, limit, laneScopes);
    if (strict.length > 0 || relaxedExpr === strictExpr) {
      return { hits: strict, relaxed: false };
    }
    const relaxed = this.lexicalLane(ftsTable, mainTable, relaxedExpr, filter, limit, laneScopes);
    return { hits: relaxed, relaxed: relaxed.length > 0 };
  }

  /**
   * `laneScopes` is the scope set for THIS table's `scope` column — the doc
   * lane set for `docs`, the fact scope set for `facts`. Same column name, two
   * different axes; the predicate is identical either way.
   *
   * The query is ASSEMBLED ONCE from accumulated `joins`/`conds`/`params`. It
   * used to be rebuilt from scratch in each branch, and the sessions branch
   * silently clobbered the scope join written by the branch above it — which
   * only stayed harmless while the two could never both apply.
   */
  private lexicalLane(
    ftsTable: string,
    mainTable: string,
    matchExpr: string,
    filter: SessionFilter | undefined,
    limit: number,
    laneScopes?: string[],
  ): LaneHit[] {
    if (!matchExpr) return [];
    const params: unknown[] = [matchExpr];
    const joins: string[] = [];
    const conds: string[] = [];
    // docs AND facts: push the scope predicate INTO the candidate query.
    // Filtering after a top-N fetch was the real "declared a lane, got zero
    // docs" bug — the N best candidates are dominated by the default lane, so
    // the declared lane never reaches the fusion step at all.
    const scoped =
      (mainTable === "docs" || mainTable === "facts") && !!laneScopes && laneScopes.length > 0;
    // project/workspace are session-only dimensions — facts and docs carry
    // neither column and are returned unfiltered.
    const sessionFiltered =
      mainTable === "sessions" && !!(filter?.project || filter?.workspace);
    if (scoped || sessionFiltered) joins.push(`join ${mainTable} m on m.id = f.rowid`);
    if (scoped) {
      const ph = laneScopes!.map(() => "?").join(",");
      conds.push(`m.scope in (${ph})`);
      params.push(...laneScopes!);
    }
    if (mainTable === "sessions" && filter?.project) {
      conds.push("m.project = ?");
      params.push(filter.project);
    }
    if (mainTable === "sessions" && filter?.workspace) {
      conds.push("m.workspace = ?");
      params.push(filter.workspace);
    }
    let sql = `select f.rowid as id, bm25(${ftsTable}) as rank from ${ftsTable} f${
      joins.length > 0 ? ` ${joins.join(" ")}` : ""
    } where ${ftsTable} match ?`;
    if (conds.length > 0) sql += ` and ${conds.join(" and ")}`;
    sql += ` order by rank asc limit ?`;
    params.push(limit);
    let rows: Row[];
    try {
      rows = this.db.prepare(sql).all(...params) as Row[];
    } catch {
      return [];
    }
    return rows.map((r, i) => ({ id: Number(r.id), rank: i }));
  }

  /**
   * `laneScopes` restricts a scoped vector lane to the caller's declared
   * scopes — the doc lane set for `vec_docs`, the fact scope set for
   * `vec_facts`. Same mechanism, two axes.
   *
   * sqlite-vec's KNN takes `k` before any join, so unlike the lexical lane the
   * predicate cannot be pushed into the query — it is an OVER-FETCH: ask for
   * `k * VEC_SCOPE_OVERFETCH`, drop the out-of-scope rows, re-rank densely, cut
   * to `limit`. That is a mitigation, not a guarantee: a scope that is a tiny
   * fraction of a very large corpus can still be crowded out of the widened
   * window. It is moot on the fact lane, which is a few dozen rows, and real on
   * a five-figure doc-chunk corpus. Postgres filters exactly, in SQL.
   */
  private vectorLane(
    vecTable: string,
    queryVec: number[] | null,
    limit: number,
    laneScopes?: string[],
  ): LaneHit[] {
    if (!queryVec || !this.vectorActive()) return [];
    // the table carrying the `scope` column for this vector index.
    const scopeTable =
      vecTable === "vec_docs" ? "docs" : vecTable === "vec_facts" ? "facts" : null;
    const scoped = scopeTable !== null && !!laneScopes && laneScopes.length > 0;
    const k = scoped ? limit * VEC_SCOPE_OVERFETCH : limit;
    let rows: Row[];
    try {
      rows = this.db
        .prepare(
          `select rowid as id, distance from ${vecTable} where embedding match ? and k = ? order by distance`,
        )
        .all(JSON.stringify(queryVec), k) as Row[];
    } catch {
      return [];
    }
    if (scoped && rows.length > 0) {
      const ids = rows.map((r) => Number(r.id));
      const ph = ids.map(() => "?").join(",");
      const scopePh = laneScopes!.map(() => "?").join(",");
      const keep = new Set(
        (
          this.db
            .prepare(`select id from ${scopeTable} where id in (${ph}) and scope in (${scopePh})`)
            .all(...ids, ...laneScopes!) as Row[]
        ).map((r) => Number(r.id)),
      );
      rows = rows.filter((r) => keep.has(Number(r.id))).slice(0, limit);
    }
    return rows.map((r, i) => ({ id: Number(r.id), rank: i }));
  }

  private factsMeta(ids: number[], scopes?: string[]): Map<number, CandidateMeta> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    // active only: an archived fact is a retracted rule and must not survive
    // recall — filtering here (not just demoting) means a lane hit with no
    // meta entry can be dropped by the caller. See recall().
    // ...and scope-filtered when the caller narrowed the fact lane, mirroring
    // docsMeta's non-flag branch. No new drop logic: recall() already re-ranks
    // facts on `meta.has`.
    const params: unknown[] = [...ids];
    let scopeSql = "";
    if (scopes && scopes.length > 0) {
      scopeSql = ` and scope in (${scopes.map(() => "?").join(",")})`;
      params.push(...scopes);
    }
    const rows = this.db
      .prepare(
        `select id, pinned, importance, status, scope from facts where id in (${placeholders}) and status = 'active'${scopeSql}`,
      )
      .all(...params) as Row[];
    for (const r of rows) {
      map.set(Number(r.id), {
        sourceType: "fact",
        id: Number(r.id),
        pinned: Number(r.pinned) === 1,
        importance: Number(r.importance),
        factScope: String(r.scope),
      });
    }
    return map;
  }

  private sessionsMeta(ids: number[]): Map<number, CandidateMeta> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `select id, created_at from sessions where id in (${placeholders})`,
      )
      .all(...ids) as Row[];
    for (const r of rows) {
      map.set(Number(r.id), {
        sourceType: "session",
        id: Number(r.id),
        createdAt: String(r.created_at),
      });
    }
    return map;
  }

  /**
   * `flagMode` (used only by `impact()`) fetches EVERY row in `ids` — no scope
   * predicate — and instead records `.scope`/`.inScope` per row so the caller
   * can flag out-of-lane docs rather than dropping them. Defaults to false so
   * `recall()`'s call site (filter-then-drop, unchanged) is untouched.
   */
  private docsMeta(
    ids: number[],
    scopes: string[],
    flagMode = false,
  ): Map<number, CandidateMeta> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    if (flagMode) {
      const rows = this.db
        .prepare(
          `select id, status, scope from docs where id in (${placeholders})`,
        )
        .all(...ids) as Row[];
      for (const r of rows) {
        const scope = String(r.scope);
        map.set(Number(r.id), {
          sourceType: "doc",
          id: Number(r.id),
          active: String(r.status) === "active",
          scope,
          inScope: scopes.includes(scope),
        });
      }
      return map;
    }
    // scope-filtered: a lane hit outside the caller's declared scopes must not
    // survive recall — filtering here (not just demoting) means a lane hit with
    // no meta entry can be dropped by the caller. Mirrors the facts active-only filter.
    const scopePlaceholders = scopes.map(() => "?").join(",");
    // `path` + `source` are the document-rollup key — one extra column each,
    // read here so `fuseLane` can collapse a file's chunks without a second
    // round trip. This meta type is engine-internal, not the frozen contract.
    const rows = this.db
      .prepare(
        `select id, status, path, source from docs where id in (${placeholders}) and scope in (${scopePlaceholders})`,
      )
      .all(...ids, ...scopes) as Row[];
    for (const r of rows) {
      map.set(Number(r.id), {
        sourceType: "doc",
        id: Number(r.id),
        active: String(r.status) === "active",
        path: (r.path as string | null) ?? null,
        source: (r.source as string | null) ?? null,
      });
    }
    return map;
  }

  async recall(query: string, opts?: RecallOptions): Promise<ListResult<RecallResult>> {
    const sources: SourceType[] = opts?.sources ?? ["fact", "session", "doc"];
    const limit = opts?.limit ?? 10;
    // default doc-lane read-set is ['global'] when the caller declares nothing —
    // the leak fix that keeps e.g. an "administration" lane out of the default
    // engineering recall pool. Hoisted here because it now feeds the candidate
    // queries themselves, not just the post-fetch meta filter.
    const scopesDeclared = !!(opts?.scopes && opts.scopes.length > 0);
    const docScopes = scopesDeclared ? opts!.scopes! : ["global"];
    // FACT-lane scope set — a different axis on a same-named column. `null`
    // when the caller declared neither `factScopes` nor `project`, which is
    // today's unnarrowed behaviour and keeps `agent:`/`machine:` facts
    // reachable from a plain recall.
    const factScopes = recallFactScopes({
      factScopes: opts?.factScopes,
      project: opts?.project,
    });
    const factLaneScopes = factScopes ?? undefined;
    const ctx: RecallContext = { query, project: opts?.project };
    // laneN >= 3*limit and >= limit at every limit, so the widened fuse-cap
    // below can never ask a lane for more candidates than the SQL fetch
    // supplies — and laneN grows with limit, so large limits need no
    // adjustment either.
    const laneN = Math.max(limit * 3, 20);
    const matchExpr = sanitizeFts(query, "strict");
    const relaxedExpr = sanitizeFts(query, "relaxed");
    // lexical accounting for meta.lexical — raw hits, pre-filter, pre-fusion.
    let lexCandidates = 0;
    const relaxedSources: SourceType[] = [];
    // sourceCaps is a per-lane RANKING cap, never a bound on the total answer:
    // widen it to at least `limit` so one lane can supply the whole flat
    // top-`limit`. Full rationale on effectiveSourceCaps.
    // ...then bounded by `recall.laneShare` so one lane cannot occupy the whole
    // multi-source answer. `sources` is threaded in on purpose: a single-source
    // recall is share-exempt.
    const recallCfg = withEffectiveSourceCaps(this.cfg, limit, sources);

    const wantVector =
      !opts?.lexicalOnly && this.vectorActive() && query.trim().length > 0;
    const queryVec = wantVector ? await this.embedOne(embedQueryText(query)) : null;

    const fused: FusedItem[] = [];
    const orderMeta = new Map<string, CandidateMeta>();
    // Per-lane accounting is stashed here and turned into `bySource` only after
    // the global limit is applied — `returned` has to be counted post-slice so
    // that Σ bySource[*].returned === meta.returned (MCP's metaLine and the UI
    // chips render that sum literally).
    const laneStats: Partial<
      Record<SourceType, { available: number; laneSaturated: boolean }>
    > = {};

    if (sources.includes("fact")) {
      const rawVec = this.vectorLane("vec_facts", queryVec, laneN, factLaneScopes);
      const lexRes = this.lexicalLaneWithFallback(
        "fts_facts",
        "facts",
        matchExpr,
        relaxedExpr,
        undefined,
        laneN,
        factLaneScopes,
      );
      const rawLex = lexRes.hits;
      lexCandidates += rawLex.length;
      if (lexRes.relaxed) relaxedSources.push("fact");
      const ids = unionIds(rawVec, rawLex);
      const meta = this.factsMeta(ids, factLaneScopes);
      // meta is already filtered to status='active' (and to the declared fact
      // scopes); drop any lane hit whose id has no meta entry and re-rank so
      // RRF ranks stay dense — mirrors filterSessionVecByProject below.
      const vec = rawVec.filter((h) => meta.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
      const lex = rawLex.filter((h) => meta.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
      // No per-lane `.slice(0, limit)`: `limit` is a total across sources now,
      // applied once by rankFlat below. sourceCaps still caps inside fuseLane,
      // but at `recallCfg`'s effective (≥ limit) width — see recallCfg above.
      const out = fuseLane("fact", vec, lex, meta, recallCfg, Date.now(), ctx);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`fact:${f.id}`, m);
      }
      // available = meta.size: ids that had a lexical or vector hit AND passed
      // scope/status filtering, computed before the sourceCaps fuse-cap and the
      // global limit. No extra query — meta is already fetched. It is a FLOOR,
      // not an exact count: meta.size can never exceed laneN, which grows with
      // `limit`, so the same query reports a larger `available` at a larger
      // limit. Never treat it as "how many more rows exist".
      laneStats.fact = {
        available: meta.size,
        laneSaturated: rawVec.length >= laneN || rawLex.length >= laneN,
      };
    }

    if (sources.includes("session")) {
      const rawVec = this.vectorLane("vec_sessions", queryVec, laneN);
      const sessionFilter: SessionFilter = {
        project: opts?.project,
        workspace: opts?.workspace,
      };
      const lexRes = this.lexicalLaneWithFallback(
        "fts_sessions",
        "sessions",
        matchExpr,
        relaxedExpr,
        sessionFilter,
        laneN,
      );
      const rawLex = lexRes.hits;
      lexCandidates += rawLex.length;
      if (lexRes.relaxed) relaxedSources.push("session");
      // when a session filter is set, restrict the vector lane the same way
      const filteredVec =
        sessionFilter.project || sessionFilter.workspace
          ? this.filterSessionVec(rawVec, sessionFilter)
          : rawVec;
      const ids = unionIds(filteredVec, rawLex);
      const meta = this.sessionsMeta(ids);
      const out = fuseLane("session", filteredVec, rawLex, meta, recallCfg);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`session:${f.id}`, m);
      }
      laneStats.session = {
        available: meta.size,
        laneSaturated: rawVec.length >= laneN || rawLex.length >= laneN,
      };
    }

    if (sources.includes("doc")) {
      const rawVec = this.vectorLane("vec_docs", queryVec, laneN, docScopes);
      const lexRes = this.lexicalLaneWithFallback(
        "fts_docs",
        "docs",
        matchExpr,
        relaxedExpr,
        undefined,
        laneN,
        docScopes,
      );
      const rawLex = lexRes.hits;
      lexCandidates += rawLex.length;
      if (lexRes.relaxed) relaxedSources.push("doc");
      const ids = unionIds(rawVec, rawLex);
      const meta = this.docsMeta(ids, docScopes);
      // meta is already filtered to the declared scopes; drop any lane hit whose
      // id has no meta entry (out-of-scope) and re-rank so RRF ranks stay dense.
      // Known/accepted: lanes fetch laneN candidates before this filter, so a query
      // dominated by out-of-scope docs can return fewer than `limit` in-scope hits.
      const vec = rawVec.filter((h) => meta.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
      const lex = rawLex.filter((h) => meta.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
      const out = fuseLane("doc", vec, lex, meta, recallCfg);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`doc:${f.id}`, m);
      }
      laneStats.doc = {
        available: meta.size,
        laneSaturated: rawVec.length >= laneN || rawLex.length >= laneN,
      };
    }

    // One flat ranking by fused score across every lane, then ONE cut at
    // `limit` — the caller asking for 5 gets the 5 best rows, not 5 per source.
    // laneN (limit*3, floor 20) keeps each lane's candidate pool comfortably
    // wider than the total limit, so a strong lane can legitimately win most of
    // the answer without starving the others of candidates.
    const rankedAll = applyLaneFloor(
      rankFlat(fused, orderMeta, this.cfg.recall.tieBreakOrder),
      "doc",
      scopesDeclared && sources.includes("doc") ? DOC_LANE_FLOOR : 0,
      limit,
    );
    const ordered = rankedAll.slice(0, limit);
    const data = ordered.map((f) => this.toRecallResult(f));
    // bySource.returned is counted POST-slice, so Σ returned === meta.returned.
    // (sqlite's toRecallResult is synchronous and never drops a row, so counting
    // `ordered` is exact; postgres has to count its hydrated output instead.)
    const bySource: NonNullable<DeliveryMeta["bySource"]> = {};
    for (const [st, stats] of Object.entries(laneStats) as [
      SourceType,
      { available: number; laneSaturated: boolean },
    ][]) {
      const returned = ordered.filter((f) => f.sourceType === st).length;
      bySource[st] = {
        returned,
        available: stats.available,
        truncated: returned < stats.available || stats.laneSaturated,
      };
    }
    const totalAvailable = Object.values(bySource).reduce((sum, s) => sum + (s?.available ?? 0), 0);
    const anyTruncated = Object.values(bySource).some((s) => s?.truncated);
    const meta: DeliveryMeta = {
      returned: data.length,
      available: totalAvailable,
      truncated: anyTruncated,
      limit,
      bySource,
      lexical: lexicalMeta(lexCandidates, relaxedSources, queryVec !== null),
      scopeFilter: scopeFilterMeta(sources, docScopes, scopesDeclared, factScopes),
    };
    return { data, meta };
  }

  /**
   * Reverse lookup: "what depends on this subject?" — see Store.impact's doc
   * comment in contract.ts. Lexical-only by construction (no vector lane, no
   * embedding call). Docs are fetched across ALL lanes (flag-mode `docsMeta`)
   * and flagged `inScope`/`scope` rather than dropped, so an agent learns THAT
   * an out-of-lane doc depends on the subject without seeing its content.
   */
  async impact(subject: string, opts?: ImpactOptions): Promise<ListResult<ImpactResult>> {
    const sources: SourceType[] = opts?.sources ?? ["fact", "session", "doc"];
    const limit = opts?.limit ?? 20;
    const laneN = Math.max(limit * 3, 20);
    // STRICT, and no relaxed fallback: a dependency tripwire must fire on the
    // subject, not on resemblance to part of it. OR-ing a multi-word subject
    // would invent dependencies that do not exist — the opposite of what an
    // agent about to delete something needs. (Postgres' websearch parser ANDs
    // by default, so this is also what makes the two adapters agree here.)
    const matchExpr = sanitizeFts(subject, "strict");
    const declaredScopes = opts?.scopes && opts.scopes.length > 0 ? opts.scopes : ["global"];
    // `limit` is authoritative for impact — recall's sourceCaps are a RANKING
    // cap (a top-N reading list) and must not bound a dependency pre-flight.
    // "42 things depend on this, here are 10" is the wrong answer to give an
    // agent about to delete something, even with truncated:true saying so.
    const impactCfg: GroundedConfig = {
      ...this.cfg,
      recall: {
        ...this.cfg.recall,
        sourceCaps: { fact: limit, session: limit, doc: limit },
      },
    };

    const fused: FusedItem[] = [];
    const orderMeta = new Map<string, CandidateMeta>();
    const bySource: NonNullable<DeliveryMeta["bySource"]> = {};

    for (const st of sources) {
      const [ftsTable, mainTable] =
        st === "fact" ? ["fts_facts", "facts"]
        : st === "session" ? ["fts_sessions", "sessions"]
        : ["fts_docs", "docs"];
      const lex = this.lexicalLane(
        ftsTable,
        mainTable,
        matchExpr,
        st === "session" ? { project: opts?.project } : undefined,
        laneN,
      );
      if (lex.length === 0) continue;
      const ids = lex.map((h) => h.id);
      const meta =
        st === "doc"
          ? this.docsMeta(ids, declaredScopes, true)
          : st === "fact"
            ? this.factsMeta(ids)
            : this.sessionsMeta(ids);
      // re-rank densely over ids present in meta — mirrors recall()'s
      // filter-then-drop idiom, except for docs (flag-mode: every hit has a
      // meta entry, none are dropped here — the withholding happens in
      // toImpactResult via meta.inScope).
      const lexFiltered = lex
        .filter((h) => meta.has(h.id))
        .map((h, i) => ({ id: h.id, rank: i }));
      const laneFused = fuseLane(st, [], lexFiltered, meta, impactCfg).slice(0, limit);
      for (const f of laneFused) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`${st}:${f.id}`, m);
      }
      const available = meta.size;
      bySource[st] = {
        returned: laneFused.length,
        available,
        truncated: laneFused.length < available || lex.length >= laneN,
      };
    }

    const ordered = orderResults(fused, orderMeta);
    const data: ImpactResult[] = [];
    for (const f of ordered) {
      const r = this.toImpactResult(f, orderMeta);
      if (r) data.push(r);
    }
    const totalAvailable = Object.values(bySource).reduce((sum, s) => sum + (s?.available ?? 0), 0);
    const anyTruncated = Object.values(bySource).some((s) => s?.truncated);
    const meta: DeliveryMeta = {
      returned: data.length,
      available: totalAvailable,
      truncated: anyTruncated,
      limit,
      bySource,
    };
    return { data, meta };
  }

  /**
   * Hydrates a fused impact hit into an `ImpactResult`. Defensive: returns
   * null (never throws) when the row vanished between the meta query and this
   * fetch — mirrors the postgres adapter. Facts/sessions are always in scope;
   * out-of-scope docs get their title/snippet withheld.
   */
  private toImpactResult(
    f: FusedItem,
    orderMeta: Map<string, CandidateMeta>,
  ): ImpactResult | null {
    // toRecallResult is NOT null-guarded (known latent issue, out of scope —
    // see the impact() spec) — it throws if the row vanished between the meta
    // query and this fetch. Guard it here instead of touching that method.
    let base: RecallResult;
    try {
      base = this.toRecallResult(f);
    } catch {
      return null;
    }
    if (!base) return null;
    if (f.sourceType !== "doc") {
      return { ...base, scope: "global", inScope: true };
    }
    const m = orderMeta.get(`doc:${f.id}`);
    const scope = m?.scope ?? "global";
    const inScope = m?.inScope !== false;
    if (inScope) {
      return { ...base, scope, inScope: true };
    }
    return { ...base, scope, inScope: false, title: null, snippet: null };
  }

  private filterSessionVec(lane: LaneHit[], filter: SessionFilter): LaneHit[] {
    if (lane.length === 0) return lane;
    const ids = lane.map((h) => h.id);
    const placeholders = ids.map(() => "?").join(",");
    const conds: string[] = [];
    const extra: unknown[] = [];
    if (filter.project) {
      conds.push("project = ?");
      extra.push(filter.project);
    }
    if (filter.workspace) {
      conds.push("workspace = ?");
      extra.push(filter.workspace);
    }
    if (conds.length === 0) return lane;
    const rows = this.db
      .prepare(
        `select id from sessions where id in (${placeholders}) and ${conds.join(" and ")}`,
      )
      .all(...ids, ...extra) as Row[];
    const keep = new Set(rows.map((r) => Number(r.id)));
    return lane.filter((h) => keep.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
  }

  private toRecallResult(f: FusedItem): RecallResult {
    if (f.sourceType === "fact") {
      const r = this.db.prepare(`select * from facts where id = ?`).get(f.id) as Row;
      const fact = this.rowToFact(r);
      return {
        sourceType: "fact",
        id: fact.id,
        typedId: `fact:${fact.id}`,
        title: fact.fact,
        score: f.score,
        matchedBy: f.matchedBy,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
        path: fact.scope,
        source: fact.source ?? null,
        citation: `fact:${fact.id} (${fact.scope})`,
        snippet: truncate(fact.detail ?? fact.fact, 200),
      };
    }
    if (f.sourceType === "session") {
      const r = this.db.prepare(`select * from sessions where id = ?`).get(f.id) as Row;
      const s = this.rowToSession(r);
      return {
        sourceType: "session",
        id: s.id,
        typedId: `session:${s.id}`,
        title: s.summary,
        score: f.score,
        matchedBy: f.matchedBy,
        createdAt: s.createdAt,
        updatedAt: s.createdAt,
        path: s.project ?? null,
        source: s.source,
        citation: `session:${s.id}${s.project ? ` (${s.project})` : ""}`,
        snippet: truncate(s.details ?? s.summary, 200),
      };
    }
    const r = this.db.prepare(`select * from docs where id = ?`).get(f.id) as Row;
    const d = this.rowToDoc(r);
    return {
      sourceType: "doc",
      id: d.id,
      typedId: `doc:${d.id}`,
      title: d.title,
      score: f.score,
      matchedBy: f.matchedBy,
      createdAt: d.ingestedAt,
      updatedAt: d.ingestedAt,
      path: d.path,
      source: d.source,
      citation: `doc:${d.source}/${d.path}#chunk${d.chunkIdx}`,
      snippet: truncate(d.body, 200),
      // one result per DOCUMENT: `id`/`citation` name the best-scoring chunk,
      // `chunks` says how many of this file's chunks matched. See fuseLane.
      ...(f.chunks !== undefined ? { chunks: f.chunks } : {}),
    };
  }

  async get(typedId: TypedId): Promise<FullRecord | null> {
    const sep = typedId.indexOf(":");
    const type = typedId.slice(0, sep) as SourceType;
    const id = Number(typedId.slice(sep + 1));
    if (type === "fact") {
      const record = await this.factsGet(id);
      return record ? { sourceType: "fact", record } : null;
    }
    if (type === "session") {
      const record = await this.sessionsGet(id);
      return record ? { sourceType: "session", record } : null;
    }
    if (type === "doc") {
      const record = await this.docsGet(id);
      return record ? { sourceType: "doc", record } : null;
    }
    return null;
  }

  async brief(opts?: BriefOptions): Promise<BriefResult> {
    const o = opts ?? {};
    const recentN = o.recentSessions ?? 8;
    // Fetch 200, render `recentN`: same reason as the facts lane below. At a
    // fetch of 8 the sessions reserve never binds, so a truncated lane had no
    // ids to name and droppedItems came back empty while meta said
    // `truncated: true` — 42 sessions withheld silently (measured 2026-09-01).
    // engine/brief.ts caps the RENDERED list at `recentN`; the surplus rows
    // exist only so they can be named in droppedItems.
    const recentSessionsResult = await this.sessionsList({
      project: o.project,
      limit: Math.max(recentN, 200),
    });
    // Bumped 30 -> 200: at 30, facts 31+ are invisible to the brief's reserve
    // and can never be named in droppedItems (their ids were never fetched).
    const factsResult = await this.factsList({
      status: "active",
      scopes: deriveFactScopes(o),
      limit: 200,
    });
    let relatedDocs: RecallResult[] = [];
    const hint = o.query ?? o.cwd;
    if (hint) {
      // Over-fetch chunk hits and keep one row per FILE: recall ranks CHUNKS,
      // so a fetch of exactly the lane's 5 slots returns 5 chunks of 2-3 files
      // (measured: 5 slots, 3 unique files). fillRelatedDocs owns the sizing.
      relatedDocs = await fillRelatedDocs(
        async (limit) =>
          (await this.recall(hint, { sources: ["doc"], limit, scopes: deriveDocScopes(o) })).data,
      );
    }
    const vision = {
      global: await this.visionGet("global"),
      project: o.project ? await this.visionGet(`project:${o.project}`) : null,
    };
    return assembleBrief(
      {
        vision,
        recentSessions: recentSessionsResult.data,
        facts: factsResult.data,
        relatedDocs,
        // The true pre-reserve counts, so assembleBrief's meta/droppedItems
        // report what actually matched — not just what this fetch window held.
        factsAvailable: factsResult.meta.available,
        recentSessionsAvailable: recentSessionsResult.meta.available,
      },
      o,
      this.cfg,
    );
  }

  async health(): Promise<HealthReport> {
    const counts = {
      facts: (this.db.prepare(`select count(*) c from facts`).get() as Row).c as number,
      sessions: (this.db.prepare(`select count(*) c from sessions`).get() as Row)
        .c as number,
      docs: (this.db.prepare(`select count(*) c from docs`).get() as Row).c as number,
      documents: (this.db.prepare(`select count(*) c from docs where chunk_idx = 0`).get() as Row)
        .c as number,
      // whole-DB file size (page_count * page_size) — closest analog to pg_total_relation_size
      bytes: (() => {
        const pc = (this.db.prepare(`pragma page_count`).get() as Row).page_count as number;
        const ps = (this.db.prepare(`pragma page_size`).get() as Row).page_size as number;
        return Number(pc) * Number(ps);
      })(),
    };
    const embHealth = await this.embedder.health();
    return {
      ok: embHealth.ok || !this.embedder.enabled,
      storage: {
        adapter: "sqlite",
        ok: true,
        detail: this.vectorActive() ? "sqlite-vec + fts5" : "fts5 (lexical-only)",
        location: this.cfg.storage.path,
      },
      embeddings: {
        provider: this.embedder.id,
        ok: embHealth.ok,
        dims: this.embedder.dims,
        detail: embHealth.detail,
        model: this.cfg.embeddings.model,
      },
      counts: {
        facts: Number(counts.facts),
        sessions: Number(counts.sessions),
        docs: Number(counts.docs),
        documents: Number(counts.documents),
        bytes: Number(counts.bytes),
      },
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function unionIds(a: LaneHit[], b: LaneHit[]): number[] {
  const set = new Set<number>();
  for (const h of a) set.add(h.id);
  for (const h of b) set.add(h.id);
  return [...set];
}

function truncate(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export async function openSqliteStore(
  cfg: GroundedConfig,
  embedder: EmbeddingProvider,
): Promise<Store> {
  const store = new SqliteStore(cfg, embedder);
  await store.init();
  return store;
}
