import pg from "pg";
import pgvector from "pgvector/pg";
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
  scopeFilterMeta,
  withEffectiveSourceCaps,
  type CandidateMeta,
  type RecallContext,
  type FusedItem,
  type LaneHit,
  type LexicalMode,
  type SessionFilter,
} from "../engine/recall.js";
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
import { readFileSync, existsSync } from "node:fs";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export class PostgresStore implements Store {
  private pool: pg.Pool;
  private readonly schema: string;
  private readonly dims: number;

  constructor(
    private readonly cfg: GroundedConfig,
    private readonly embedder: EmbeddingProvider,
  ) {
    if (!cfg.storage.url) throw new StoreError("postgres adapter requires storage.url");
    this.schema = cfg.storage.schema ?? "public";
    this.dims = embedder.enabled ? embedder.dims : (cfg.embeddings.dims ?? 768);
    this.pool = new pg.Pool({ connectionString: cfg.storage.url });
    this.pool.on("connect", (client) => {
      void pgvector.registerType(client);
    });
  }

  private q(table: string): string {
    return `"${this.schema}".${table}`;
  }

  private vectorActive(): boolean {
    return this.embedder.enabled;
  }

  private async embedOne(text: string): Promise<number[] | null> {
    if (!this.vectorActive()) return null;
    const vecs = await this.embedder.embed([text]);
    const v = vecs[0];
    if (!v || v.length === 0) return null;
    return v;
  }

  async init(): Promise<void> {
    const { postgresSchema } = await import("./migrations/postgres.js");
    const client = await this.pool.connect();
    try {
      await pgvector.registerType(client);
      await client.query(postgresSchema(this.schema, this.dims));
    } finally {
      client.release();
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
      pinned: Boolean(r.pinned),
      importance: Number(r.importance),
      status: String(r.status) as FactStatus,
      origin: String(r.origin) as FactOrigin,
      createdBy: (r.created_by as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  /**
   * Plain insert — no topicKey (never collides; the partial unique index
   * excludes null topic_key) or an explicit non-active status (the index
   * only constrains status='active', so an archived insert can share a key
   * with nothing — or with an already-archived duplicate).
   */
  private async factsInsert(input: FactInput): Promise<Fact> {
    const emb = await this.embedOne(`${input.fact}\n${input.detail ?? ""}`.trim());
    const res = await this.pool.query(
      `insert into ${this.q("facts")}(scope, category, fact, detail, topic_key, pinned, importance, status, created_by, source, origin, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [
        input.scope ?? "global",
        input.category ?? "",
        input.fact,
        input.detail ?? null,
        input.topicKey ?? null,
        input.pinned ?? false,
        // default 0.6, not the column's DDL default of 0: feeds `pinned desc,
        // importance desc, updated_at desc` ordering in factsList — a fact
        // written with no explicit importance should tie the unpinned cluster,
        // not sort dead last.
        input.importance ?? 0.6,
        input.status ?? "active",
        input.createdBy ?? null,
        input.source ?? null,
        input.origin ?? "stated",
        emb ? pgvector.toSql(emb) : null,
      ],
    );
    return this.rowToFact(res.rows[0] as Row);
  }

  /**
   * factsAdd is an upsert-in-place on (scope, topicKey) among ACTIVE rows —
   * see idx_facts_topic_key. Verified against a real postgres that
   * `insert ... on conflict (scope, topic_key) where topic_key is not null
   * and status = 'active' do update ...` works cleanly targeting the partial
   * index. Chose a read-then-branch instead (transactional `select ... for
   * update` + conditional insert/update) so re-embedding only happens when
   * the fact/detail text actually changed, matching factsUpdate's existing
   * textChanged guard below — a blind ON CONFLICT would have to embed on
   * every call before knowing whether the write collides, paying an ollama
   * round trip on what may turn out to be a no-op text update.
   */
  async factsAdd(input: FactInput): Promise<Fact> {
    const scope = input.scope ?? "global";
    const topicKey = input.topicKey ?? null;
    const status = input.status ?? "active";
    if (topicKey == null || status !== "active") {
      return this.factsInsert(input);
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existingRes = await client.query(
        `select * from ${this.q("facts")} where scope = $1 and topic_key = $2 and status = 'active' for update`,
        [scope, topicKey],
      );
      const priorRow = existingRes.rows[0] as Row | undefined;
      if (!priorRow) {
        // No colliding active row. Insert inside the same transaction so the
        // `for update` scan above at least serializes with another
        // concurrent upsert attempt on this key; the unique index remains
        // the final guarantee against a true race (a losing racer sees a
        // duplicate-key error rather than a silent second row).
        const emb = await this.embedOne(`${input.fact}\n${input.detail ?? ""}`.trim());
        const res = await client.query(
          `insert into ${this.q("facts")}(scope, category, fact, detail, topic_key, pinned, importance, status, created_by, source, origin, embedding)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
          [
            scope,
            input.category ?? "",
            input.fact,
            input.detail ?? null,
            topicKey,
            input.pinned ?? false,
            input.importance ?? 0.6,
            status,
            input.createdBy ?? null,
            input.source ?? null,
            input.origin ?? "stated",
            emb ? pgvector.toSql(emb) : null,
          ],
        );
        await client.query("commit");
        return this.rowToFact(res.rows[0] as Row);
      }
      // MERGE-PATCH semantics, not full replacement: a field the caller omits
      // keeps the stored value rather than resetting to the insert-time default.
      //
      // The alternative loses operator curation silently. `pinned` and
      // `importance` are deliberately curated per fact; an agent restating a
      // rule through ground_facts_add without repeating `pinned: true` would
      // unpin it, with a 200 and no signal — the same invisible mutation of
      // operator-authored data this initiative already refused once when it
      // declined to retro-rewrite the live facts. Requiring a caller to restate
      // every field to preserve it makes omission destructive by default.
      //
      // Must stay identical to the sqlite adapter, which reaches the same
      // behaviour by delegating to factsUpdate's patch merge.
      const prior = this.rowToFact(priorRow);
      const nextCategory = input.category ?? prior.category;
      const nextDetail = input.detail ?? prior.detail ?? null;
      const nextPinned = input.pinned ?? prior.pinned;
      const nextImportance = input.importance ?? prior.importance;
      const nextCreatedBy = input.createdBy ?? prior.createdBy ?? null;
      const nextSource = input.source ?? prior.source ?? null;
      const nextOrigin = input.origin ?? prior.origin;
      const textChanged = input.fact !== prior.fact || (nextDetail ?? "") !== (prior.detail ?? "");
      const emb = textChanged
        ? await this.embedOne(`${input.fact}\n${nextDetail ?? ""}`.trim())
        : null;
      const res = await client.query(
        `update ${this.q("facts")} set category=$1, fact=$2, detail=$3, pinned=$4, importance=$5,
           created_by=$6, source=$7, origin=$8, updated_at=now()${
             textChanged ? ", embedding=$10" : ""
           } where id=$9 returning *`,
        [
          nextCategory,
          input.fact,
          nextDetail,
          nextPinned,
          nextImportance,
          nextCreatedBy,
          nextSource,
          nextOrigin,
          prior.id,
          ...(textChanged ? [emb ? pgvector.toSql(emb) : null] : []),
        ],
      );
      await client.query("commit");
      return this.rowToFact(res.rows[0] as Row);
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async factsList(opts?: ListOptions): Promise<ListResult<Fact>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts?.scopes && opts.scopes.length > 0) {
      params.push(opts.scopes);
      where.push(`scope = ANY($${params.length}::text[])`);
    } else if (opts?.scope) {
      params.push(opts.scope);
      where.push(`scope = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countParams = [...params];
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const [res, countRes] = await Promise.all([
      this.pool.query(
        `select * from ${this.q("facts")} ${whereSql} order by pinned desc, importance desc, updated_at desc limit $${limitIdx} offset $${offsetIdx}`,
        params,
      ),
      this.pool.query(`select count(*) from ${this.q("facts")} ${whereSql}`, countParams),
    ]);
    const data = (res.rows as Row[]).map((r) => this.rowToFact(r));
    const available = Number((countRes.rows[0] as Row).count);
    return {
      data,
      meta: {
        returned: data.length,
        available,
        truncated: offset + data.length < available,
        limit,
      },
    };
  }

  async factsGet(id: number): Promise<Fact | null> {
    const res = await this.pool.query(
      `select * from ${this.q("facts")} where id = $1`,
      [id],
    );
    const r = res.rows[0] as Row | undefined;
    return r ? this.rowToFact(r) : null;
  }

  async factsDelete(id: number): Promise<boolean> {
    const res = await this.pool.query(
      `delete from ${this.q("facts")} where id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Partial patch (not a full replacement, unlike factsAdd's upsert branch):
   * every omitted field keeps its existing value, including `origin` — a
   * PATCH that only touches `pinned` must not silently reset a `derived`
   * fact back to `stated`.
   *
   * Edge case: un-archiving a row (status archived -> active) into a
   * (scope, topicKey) that collides with an already-active row is left to
   * the database's own idx_facts_topic_key constraint rather than resolved
   * here — verified live: the UPDATE raises a 23505 unique_violation, which
   * is caught below and rethrown as a StoreError naming the collision. This
   * is deliberately NOT auto-reconciled (no silent merge, no silent second
   * key, no silent overwrite of the other row) — the operator must resolve
   * it explicitly, e.g. by archiving the other row or renaming this one's
   * key, exactly as the plan's non-destructive posture requires everywhere
   * else in this stage.
   */
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
      createdBy: patch.createdBy !== undefined ? patch.createdBy : existing.createdBy,
      source: patch.source !== undefined ? patch.source : existing.source,
    };
    const textChanged = next.fact !== existing.fact || (next.detail ?? "") !== (existing.detail ?? "");
    const emb = textChanged
      ? await this.embedOne(`${next.fact}\n${next.detail ?? ""}`.trim())
      : null;
    try {
      const res = await this.pool.query(
        `update ${this.q("facts")} set scope=$1, category=$2, fact=$3, detail=$4, topic_key=$5, pinned=$6, importance=$7, status=$8, origin=$9, created_by=$10, source=$11, updated_at=now()${
          textChanged ? ", embedding=$13" : ""
        } where id=$12 returning *`,
        [
          next.scope,
          next.category,
          next.fact,
          next.detail ?? null,
          next.topicKey ?? null,
          next.pinned,
          next.importance,
          next.status,
          next.origin,
          next.createdBy ?? null,
          next.source ?? null,
          id,
          ...(textChanged ? [emb ? pgvector.toSql(emb) : null] : []),
        ],
      );
      return this.rowToFact(res.rows[0] as Row);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new StoreError(
          `fact ${id} update collides with an already-active fact for scope "${next.scope}" topicKey "${next.topicKey}" — archive or re-key one of them first`,
        );
      }
      throw err;
    }
  }

  /**
   * Delivery rank for one fact: 1-based position within `factsList`'s own
   * ordering (pinned desc, importance desc, updated_at desc), scoped to the
   * fact's own scope + status='active'. Null when missing or not active.
   */
  async factsDeliveryRank(id: number): Promise<{ rank: number; ofActive: number } | null> {
    const fact = await this.factsGet(id);
    if (!fact || fact.status !== "active") return null;
    const res = await this.pool.query(
      // Compare against the row's OWN column values via a self-join, never a
      // re-serialized JS Date: timestamptz carries microseconds and
      // toISOString() truncates to milliseconds, so a round-tripped value is
      // almost always < the real column and the fact outranks itself. The
      // explicit `a.id <> f.id` is belt-and-braces on the same hazard.
      `select 1 + count(*) filter (
                where a.id <> f.id
                  and (a.pinned > f.pinned
                    or (a.pinned = f.pinned and a.importance > f.importance)
                    or (a.pinned = f.pinned and a.importance = f.importance
                        and a.updated_at > f.updated_at))
              ) as rank,
              count(*) as of_active
       from ${this.q("facts")} a
       cross join (select id, pinned, importance, updated_at
                   from ${this.q("facts")} where id = $1) f
       where a.scope = $2 and a.status = 'active'`,
      [id, fact.scope],
    );
    const row = res.rows[0] as Row;
    return { rank: Number(row.rank), ofActive: Number(row.of_active) };
  }

  // ---- vision --------------------------------------------------------------
  // One active record per scope; edited in place; excluded from recall (no embedding/tsv).

  private rowToVision(r: Row): Vision {
    return {
      id: Number(r.id),
      scope: String(r.scope),
      summary: (r.summary as string | null) ?? null,
      details: String(r.details),
      createdBy: (r.created_by as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  async visionGet(scope: string): Promise<Vision | null> {
    const res = await this.pool.query(
      `select * from ${this.q("vision")} where scope = $1`,
      [scope],
    );
    const r = res.rows[0] as Row | undefined;
    return r ? this.rowToVision(r) : null;
  }

  async visionList(opts?: ListOptions): Promise<ListResult<Vision>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.scope) {
      params.push(opts.scope);
      where.push(`scope = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countParams = [...params];
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const [res, countRes] = await Promise.all([
      this.pool.query(
        `select * from ${this.q("vision")} ${whereSql} order by updated_at desc limit $${limitIdx} offset $${offsetIdx}`,
        params,
      ),
      this.pool.query(`select count(*) from ${this.q("vision")} ${whereSql}`, countParams),
    ]);
    const data = (res.rows as Row[]).map((r) => this.rowToVision(r));
    const available = Number((countRes.rows[0] as Row).count);
    return {
      data,
      meta: {
        returned: data.length,
        available,
        truncated: offset + data.length < available,
        limit,
      },
    };
  }

  async visionSet(input: VisionInput): Promise<Vision> {
    const scope = input.scope ?? "global";
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const prior = await client.query(
        `select id from ${this.q("vision")} where scope = $1 for update`,
        [scope],
      );
      const priorId = prior.rows[0] ? Number((prior.rows[0] as Row).id) : null;
      // exactly one record per scope — edit it in place, or insert if none exists.
      let res;
      if (priorId != null) {
        res = await client.query(
          `update ${this.q("vision")} set details = $1, summary = $2, source = $3, updated_at = now() where id = $4 returning *`,
          [input.details, input.summary ?? null, input.source ?? null, priorId],
        );
      } else {
        res = await client.query(
          `insert into ${this.q("vision")}(scope, details, summary, created_by, source)
           values ($1, $2, $3, $4, $5) returning *`,
          [scope, input.details, input.summary ?? null, input.createdBy ?? null, input.source ?? null],
        );
      }
      const created = this.rowToVision(res.rows[0] as Row);
      await client.query("commit");
      return created;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async visionDelete(id: number): Promise<boolean> {
    const res = await this.pool.query(
      `delete from ${this.q("vision")} where id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  // ---- sessions ----------------------------------------------------------

  private rowToSession(r: Row): Session {
    const tags = r.tags as string[] | null;
    return {
      id: Number(r.id),
      machine: (r.machine as string | null) ?? null,
      project: (r.project as string | null) ?? null,
      workspace: (r.workspace as string | null) ?? null,
      agent: (r.agent as string | null) ?? null,
      summary: String(r.summary),
      details: (r.details as string | null) ?? null,
      tags: tags && tags.length ? tags : null,
      source: String(r.source),
      createdAt: new Date(r.created_at as string).toISOString(),
    };
  }

  async sessionsAdd(input: SessionInput): Promise<Session> {
    const emb = await this.embedOne(`${input.summary}\n${input.details ?? ""}`.trim());
    const res = await this.pool.query(
      `insert into ${this.q("sessions")}(machine, project, workspace, agent, summary, details, tags, source, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [
        input.machine ?? null,
        input.project ?? null,
        input.workspace ?? null,
        input.agent ?? null,
        input.summary,
        input.details ?? null,
        input.tags ?? null,
        input.source ?? "manual",
        emb ? pgvector.toSql(emb) : null,
      ],
    );
    return this.rowToSession(res.rows[0] as Row);
  }

  async sessionsList(opts?: ListOptions): Promise<ListResult<Session>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.project) {
      params.push(opts.project);
      where.push(`project = $${params.length}`);
    }
    if (opts?.workspace) {
      params.push(opts.workspace);
      where.push(`workspace = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countParams = [...params];
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const [res, countRes] = await Promise.all([
      this.pool.query(
        `select * from ${this.q("sessions")} ${whereSql} order by created_at desc, id desc limit $${limitIdx} offset $${offsetIdx}`,
        params,
      ),
      this.pool.query(`select count(*) from ${this.q("sessions")} ${whereSql}`, countParams),
    ]);
    const data = (res.rows as Row[]).map((r) => this.rowToSession(r));
    const available = Number((countRes.rows[0] as Row).count);
    return {
      data,
      meta: {
        returned: data.length,
        available,
        truncated: offset + data.length < available,
        limit,
      },
    };
  }

  async sessionsGet(id: number): Promise<Session | null> {
    const res = await this.pool.query(
      `select * from ${this.q("sessions")} where id = $1`,
      [id],
    );
    const r = res.rows[0] as Row | undefined;
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
    const embedding = textChanged
      ? await this.embedOne(`${next.summary}\n${next.details ?? ""}`.trim())
      : null;
    const sets = [
      "summary = $2",
      "details = $3",
      "project = $4",
      "workspace = $5",
      "agent = $6",
      "machine = $7",
      "tags = $8",
      "source = $9",
    ];
    const params: unknown[] = [
      id,
      next.summary,
      next.details ?? null,
      next.project ?? null,
      next.workspace ?? null,
      next.agent ?? null,
      next.machine ?? null,
      next.tags ?? null,
      next.source ?? null,
    ];
    if (embedding) {
      params.push(pgvector.toSql(embedding));
      sets.push(`embedding = $${params.length}`);
    }
    await this.pool.query(
      `update ${this.q("sessions")} set ${sets.join(", ")} where id = $1`,
      params,
    );
    const s = await this.sessionsGet(id);
    if (!s) throw new StoreError("failed to read updated session");
    return s;
  }

  async sessionsDelete(id: number): Promise<boolean> {
    const res = await this.pool.query(
      `delete from ${this.q("sessions")} where id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async sessionsTimeline(opts: TimelineOptions): Promise<Session[]> {
    const window = opts.window ?? 5;
    if (opts.around != null) {
      const anchorRes = await this.pool.query(
        `select created_at from ${this.q("sessions")} where id = $1`,
        [opts.around],
      );
      const anchor = anchorRes.rows[0] as Row | undefined;
      if (!anchor) return [];
      const beforeRes = await this.pool.query(
        `select * from ${this.q("sessions")} where created_at <= $1 and id != $2 order by created_at desc, id desc limit $3`,
        [anchor.created_at, opts.around, window],
      );
      const selfRes = await this.pool.query(
        `select * from ${this.q("sessions")} where id = $1`,
        [opts.around],
      );
      const afterRes = await this.pool.query(
        `select * from ${this.q("sessions")} where created_at > $1 order by created_at asc, id asc limit $2`,
        [anchor.created_at, window],
      );
      const all = [
        ...(beforeRes.rows as Row[]).reverse(),
        ...(selfRes.rows as Row[]),
        ...(afterRes.rows as Row[]),
      ];
      return all.map((r) => this.rowToSession(r));
    }
    if (opts.query) {
      const results = await this.recall(opts.query, {
        sources: ["session"],
        project: opts.project,
        limit: window,
      });
      const out: Session[] = [];
      for (const r of results.data) {
        const s = await this.sessionsGet(r.id);
        if (s) out.push(s);
      }
      return out;
    }
    const listed = await this.sessionsList({ project: opts.project, limit: window });
    return listed.data;
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
      mtime: r.mtime ? new Date(r.mtime as string).toISOString() : null,
      status: String(r.status) as DocStatus,
      kind: (r.kind as string | null) ?? null,
      machine: (r.machine as string | null) ?? null,
      scope: String(r.scope),
      project: (r.project as string | null) ?? null,
      ingestedAt: new Date(r.ingested_at as string).toISOString(),
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

    const unreadable = rootPaths.filter((p) => !isReadableDir(p));
    if (unreadable.length > 0) throw new IngestPathError(unreadable);

    for (const root of rootPaths) {
      const files = walk(root, this.cfg.ingest.ignoreFile);
      for (const file of files) {
        report.scanned++;
        let raw: string;
        try {
          raw = readFileSync(file.absPath, "utf8");
        } catch {
          continue;
        }
        const stripped = this.cfg.ingest.stripPrivate ? stripPrivateBlocks(raw) : raw;
        // frontmatter is ALWAYS split for its tags, even when the configured
        // ingest keeps it in the indexed body.
        const split = splitFrontmatter(stripped);
        const fmTags = parseFrontmatterTags(split.frontmatter);
        const content = this.cfg.ingest.stripFrontmatter ? split.body : stripped;
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

        const existingRes = await this.pool.query(
          `select id, chunk_idx, body_hash, source, kind, machine, scope, project from ${this.q("docs")} where path = $1`,
          [docPath],
        );
        const existingByIdx = new Map<number, Row>();
        for (const e of existingRes.rows as Row[]) {
          existingByIdx.set(Number(e.chunk_idx), e);
        }

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
                await this.pool.query(
                  `update ${this.q("docs")} set source=$1, kind=$2, machine=$3, scope=$4, project=$5, ingested_at=now() where id=$6`,
                  [source, kind, machine, scope, project, Number(prev.id)],
                );
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
          const emb = await this.embedOne(chunk.body);
          const embSql = emb ? pgvector.toSql(emb) : null;
          if (prev) {
            await this.pool.query(
              `update ${this.q("docs")} set source=$1, title=$2, body=$3, total_chunks=$4, body_hash=$5, mtime=$6, status='active', kind=$7, machine=$8, scope=$9, project=$10, ingested_at=now(), embedding=$11 where id=$12`,
              [source, title, chunk.body, chunks.length, chunk.bodyHash, mtime, kind, machine, scope, project, embSql, Number(prev.id)],
            );
            report.updated++;
          } else {
            await this.pool.query(
              `insert into ${this.q("docs")}(source, path, title, body, chunk_idx, total_chunks, body_hash, mtime, status, kind, machine, scope, project, embedding)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12,$13)`,
              [source, docPath, title, chunk.body, chunk.idx, chunks.length, chunk.bodyHash, mtime, kind, machine, scope, project, embSql],
            );
            report.added++;
          }
          existingByIdx.delete(chunk.idx);
        }

        for (const [, leftover] of existingByIdx) {
          fileTouched = true;
          if (!dryRun) {
            await this.pool.query(`delete from ${this.q("docs")} where id = $1`, [
              Number(leftover.id),
            ]);
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
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts?.source) {
      params.push(opts.source);
      where.push(`source = $${params.length}`);
    }
    if (opts?.scopes && opts.scopes.length > 0) {
      params.push(opts.scopes);
      where.push(`scope = ANY($${params.length}::text[])`);
    } else if (opts?.scope) {
      params.push(opts.scope);
      where.push(`scope = $${params.length}`);
    }
    if (opts?.documents) where.push("chunk_idx = 0");
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countParams = [...params];
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    params.push(limit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const [res, countRes] = await Promise.all([
      this.pool.query(
        `select * from ${this.q("docs")} ${whereSql} order by path asc, chunk_idx asc limit $${limitIdx} offset $${offsetIdx}`,
        params,
      ),
      this.pool.query(`select count(*) from ${this.q("docs")} ${whereSql}`, countParams),
    ]);
    const data = (res.rows as Row[]).map((r) => this.rowToDoc(r));
    const available = Number((countRes.rows[0] as Row).count);
    return {
      data,
      meta: {
        returned: data.length,
        available,
        truncated: offset + data.length < available,
        limit,
      },
    };
  }

  async docsGet(id: number): Promise<Doc | null> {
    const res = await this.pool.query(
      `select * from ${this.q("docs")} where id = $1`,
      [id],
    );
    const r = res.rows[0] as Row | undefined;
    return r ? this.rowToDoc(r) : null;
  }

  async docsPrune(opts?: { remove?: boolean }): Promise<{
    missing: number;
    removed: number;
  }> {
    const res = await this.pool.query(`select distinct path from ${this.q("docs")}`);
    let missing = 0;
    let removed = 0;
    for (const r of res.rows as Row[]) {
      const path = String(r.path);
      if (!existsSync(path)) {
        if (opts?.remove) {
          const del = await this.pool.query(
            `delete from ${this.q("docs")} where path = $1`,
            [path],
          );
          removed += del.rowCount ?? 0;
        } else {
          const upd = await this.pool.query(
            `update ${this.q("docs")} set status='missing' where path = $1`,
            [path],
          );
          missing += upd.rowCount ?? 0;
        }
      }
    }
    return { missing, removed };
  }

  // ---- recall ------------------------------------------------------------

  /**
   * Run the lexical lane under the shared strict-then-relaxed policy.
   *
   * `websearch_to_tsquery` ANDs bare words, so a natural-language query ("is
   * zap decommissioned yet") requires EVERY term in one row and routinely
   * matched nothing — recall then degraded to a pure ANN ranking, silently.
   * Only when the strict query matches nothing is the same parsed tsquery
   * retried with its `&` operators rewritten to `|`: the terms are already
   * stemmed and stopword-stripped by the websearch parser, so the fallback
   * reuses that work instead of re-tokenising, and phrase/negation operators
   * are carried through untouched. A precise match is never diluted, because
   * the fallback only ever runs on an EMPTY strict lane.
   */
  private async lexicalLaneWithFallback(
    table: string,
    query: string,
    filter: SessionFilter | undefined,
    limit: number,
    docScopes?: string[],
  ): Promise<{ hits: LaneHit[]; relaxed: boolean }> {
    const strict = await this.lexicalLane(table, query, filter, limit, docScopes, "strict");
    if (strict.length > 0) return { hits: strict, relaxed: false };
    const relaxed = await this.lexicalLane(table, query, filter, limit, docScopes, "relaxed");
    return { hits: relaxed, relaxed: relaxed.length > 0 };
  }

  private async lexicalLane(
    table: string,
    query: string,
    filter: SessionFilter | undefined,
    limit: number,
    docScopes?: string[],
    mode: LexicalMode = "strict",
  ): Promise<LaneHit[]> {
    if (!query.trim()) return [];
    const params: unknown[] = [query];
    // strict: the query as written (websearch ANDs bare words). relaxed: the
    // SAME parsed tsquery with its conjunctions rewritten to disjunctions.
    const tsq =
      mode === "strict"
        ? `websearch_to_tsquery('english', $1)`
        : `replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery`;
    // doc lane: push the scope predicate INTO the candidate query. Filtering
    // after a top-N fetch was the real "declared a lane, got zero docs" bug —
    // the N best candidates are dominated by the default lane, so the declared
    // lane never reaches the fusion step at all.
    let scopeSql = "";
    if (table === "docs" && docScopes && docScopes.length > 0) {
      params.push(docScopes);
      scopeSql = ` and scope = any($${params.length}::text[])`;
    }
    // project/workspace are session-only dimensions — facts and docs carry
    // neither column and are returned unfiltered.
    let projSql = "";
    if (table === "sessions" && filter?.project) {
      params.push(filter.project);
      projSql += ` and project = $${params.length}`;
    }
    if (table === "sessions" && filter?.workspace) {
      params.push(filter.workspace);
      projSql += ` and workspace = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;
    const sql = `select id, ts_rank_cd(search_tsv, ${tsq}) as rank
                 from ${this.q(table)}
                 where search_tsv @@ ${tsq}${projSql}${scopeSql}
                 order by rank desc limit $${limitIdx}`;
    const res = await this.pool.query(sql, params);
    return (res.rows as Row[]).map((r, i) => ({ id: Number(r.id), rank: i }));
  }

  private async vectorLane(
    table: string,
    queryVec: number[] | null,
    filter: SessionFilter | undefined,
    limit: number,
    docScopes?: string[],
  ): Promise<LaneHit[]> {
    if (!queryVec || !this.vectorActive()) return [];
    const params: unknown[] = [pgvector.toSql(queryVec)];
    let projSql = "where embedding is not null";
    // same pushdown as the lexical lane — an out-of-lane row must never consume
    // one of the `limit` nearest-neighbour slots.
    if (table === "docs" && docScopes && docScopes.length > 0) {
      params.push(docScopes);
      projSql += ` and scope = any($${params.length}::text[])`;
    }
    if (table === "sessions" && filter?.project) {
      params.push(filter.project);
      projSql += ` and project = $${params.length}`;
    }
    if (table === "sessions" && filter?.workspace) {
      params.push(filter.workspace);
      projSql += ` and workspace = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;
    const sql = `select id from ${this.q(table)} ${projSql} order by embedding <=> $1 limit $${limitIdx}`;
    const res = await this.pool.query(sql, params);
    return (res.rows as Row[]).map((r, i) => ({ id: Number(r.id), rank: i }));
  }

  private async metaFor(
    sourceType: SourceType,
    ids: number[],
    docScopes?: string[],
  ): Promise<Map<number, CandidateMeta>> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    if (sourceType === "fact") {
      // active only: an archived fact is a retracted rule and must not
      // survive recall — filtering here (not just demoting) means a lane
      // hit with no meta entry can be dropped by the caller. See recall().
      const res = await this.pool.query(
        `select id, pinned, importance, status, scope from ${this.q("facts")} where id = any($1) and status = 'active'`,
        [ids],
      );
      for (const r of res.rows as Row[]) {
        map.set(Number(r.id), {
          sourceType: "fact",
          id: Number(r.id),
          pinned: Boolean(r.pinned),
          importance: Number(r.importance),
          factScope: String(r.scope),
        });
      }
    } else if (sourceType === "session") {
      const res = await this.pool.query(
        `select id, created_at from ${this.q("sessions")} where id = any($1)`,
        [ids],
      );
      for (const r of res.rows as Row[]) {
        map.set(Number(r.id), {
          sourceType: "session",
          id: Number(r.id),
          createdAt: new Date(r.created_at as string).toISOString(),
        });
      }
    } else {
      // scope-filtered: a lane hit outside the caller's declared scopes must not
      // survive recall — filtering here (not just demoting) means a lane hit with
      // no meta entry can be dropped by the caller. Mirrors the facts active-only filter.
      const scopes = docScopes && docScopes.length > 0 ? docScopes : ["global"];
      const res = await this.pool.query(
        `select id, status from ${this.q("docs")} where id = any($1) and scope = any($2::text[])`,
        [ids, scopes],
      );
      for (const r of res.rows as Row[]) {
        map.set(Number(r.id), {
          sourceType: "doc",
          id: Number(r.id),
          active: String(r.status) === "active",
        });
      }
    }
    return map;
  }

  async recall(query: string, opts?: RecallOptions): Promise<ListResult<RecallResult>> {
    const sources: SourceType[] = opts?.sources ?? ["fact", "session", "doc"];
    const limit = opts?.limit ?? 10;
    // laneN >= 3*limit and >= limit at every limit, so the widened fuse-cap
    // below can never ask a lane for more candidates than the SQL fetch
    // supplies — and laneN grows with limit, so large limits need no
    // adjustment either.
    const laneN = Math.max(limit * 3, 20);
    // sourceCaps is a per-lane RANKING cap, never a bound on the total answer:
    // widen it to at least `limit` so one lane can supply the whole flat
    // top-`limit`. Full rationale on effectiveSourceCaps.
    const recallCfg = withEffectiveSourceCaps(this.cfg, limit);
    // default doc-lane read-set is ['global'] when the caller declares nothing —
    // the leak fix that keeps e.g. an "administration" lane out of the default
    // engineering recall pool. Hoisted here because it now feeds the candidate
    // queries themselves, not just the post-fetch meta filter.
    const scopesDeclared = !!(opts?.scopes && opts.scopes.length > 0);
    const docScopes = scopesDeclared ? opts!.scopes! : ["global"];
    const ctx: RecallContext = { query, project: opts?.project };
    // lexical accounting for meta.lexical — raw hits, pre-filter, pre-fusion.
    let lexCandidates = 0;
    const relaxedSources: SourceType[] = [];
    const wantVector =
      !opts?.lexicalOnly && this.vectorActive() && query.trim().length > 0;
    const queryVec = wantVector ? await this.embedOne(query) : null;

    const tableFor: Record<SourceType, string> = {
      fact: "facts",
      session: "sessions",
      doc: "docs",
    };

    const fused: FusedItem[] = [];
    const orderMeta = new Map<string, CandidateMeta>();
    // Per-lane accounting is stashed here and turned into `bySource` only after
    // the global limit is applied — `returned` has to be counted post-slice so
    // that Σ bySource[*].returned === meta.returned (MCP's metaLine and the UI
    // chips render that sum literally).
    const laneStats: Partial<
      Record<SourceType, { available: number; laneSaturated: boolean }>
    > = {};

    for (const st of sources) {
      const table = tableFor[st];
      const proj: SessionFilter | undefined =
        st === "session"
          ? { project: opts?.project, workspace: opts?.workspace }
          : undefined;
      const laneScopes = st === "doc" ? docScopes : undefined;
      const rawVec = await this.vectorLane(table, queryVec, proj, laneN, laneScopes);
      const lexRes = await this.lexicalLaneWithFallback(table, query, proj, laneN, laneScopes);
      const rawLex = lexRes.hits;
      lexCandidates += rawLex.length;
      if (lexRes.relaxed) relaxedSources.push(st);
      let vec = rawVec;
      let lex = rawLex;
      const ids = new Set<number>();
      for (const h of vec) ids.add(h.id);
      for (const h of lex) ids.add(h.id);
      const meta = await this.metaFor(st, [...ids], docScopes);
      // `meta.size` is the honest per-source `available`: ids that had a lexical
      // or vector hit AND passed scope/status filtering, computed before the
      // sourceCaps fusion cap and the global limit below. It is a FLOOR, not an
      // exact count — see `truncated`. meta.size can never exceed `laneN`, and
      // laneN grows with `limit`, so the same query reports a larger
      // `available` at a larger limit. Never read it as "how many more exist".
      const available = meta.size;
      if (st === "fact" || st === "doc") {
        // metaFor already filtered (status='active' for facts, declared scopes for
        // docs); drop any lane hit whose id has no meta entry and re-rank so RRF
        // ranks stay dense — filterSessionVecByProject below is the same idiom for
        // the project filter. Known/accepted: lanes fetch laneN candidates before
        // this filter, so a query dominated by out-of-scope docs can return fewer
        // than `limit` in-scope hits.
        vec = vec.filter((h) => meta.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
        lex = lex.filter((h) => meta.has(h.id)).map((h, i) => ({ id: h.id, rank: i }));
      }
      // No per-lane `.slice(0, limit)`: `limit` is a total across sources now,
      // applied once by rankFlat below. sourceCaps still caps inside fuseLane,
      // but at `recallCfg`'s effective (>= limit) width — see recallCfg above.
      const laneFused = fuseLane(st, vec, lex, meta, recallCfg, Date.now(), ctx);
      for (const f of laneFused) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`${st}:${f.id}`, m);
      }
      laneStats[st] = {
        available,
        laneSaturated: rawVec.length >= laneN || rawLex.length >= laneN,
      };
    }

    // One flat ranking by fused score across every lane, then ONE cut at
    // `limit` — the caller asking for 5 gets the 5 best rows, not 5 per source.
    // laneN (limit*3, floor 20) keeps each lane's candidate pool comfortably
    // wider than the total limit, so a strong lane can legitimately win most of
    // the answer without starving the others of candidates.
    //
    // The cut is a backfill loop rather than a `.slice(limit)`: this adapter's
    // toRecallResult is async and returns null when the row vanished between
    // the lane query and the hydrate, so slicing first would silently under-fill
    // the answer. Walk the full ranking, skip nulls, stop at `limit`.
    const ordered = applyLaneFloor(
      rankFlat(fused, orderMeta),
      "doc",
      scopesDeclared && sources.includes("doc") ? DOC_LANE_FLOOR : 0,
      limit,
    );
    const out: RecallResult[] = [];
    for (const f of ordered) {
      if (out.length >= limit) break;
      const r = await this.toRecallResult(f);
      if (r) out.push(r);
    }
    // bySource.returned counted POST-limit, off the hydrated rows, so
    // Σ returned === meta.returned. (sqlite counts its `ordered` slice directly
    // — synchronous hydration, no nulls — same invariant, different mechanism.)
    const bySource: NonNullable<DeliveryMeta["bySource"]> = {};
    for (const [st, stats] of Object.entries(laneStats) as [
      SourceType,
      { available: number; laneSaturated: boolean },
    ][]) {
      const returned = out.filter((r) => r.sourceType === st).length;
      bySource[st] = {
        returned,
        available: stats.available,
        truncated: returned < stats.available || stats.laneSaturated,
      };
    }
    const available = Object.values(bySource).reduce((sum, s) => sum + (s?.available ?? 0), 0);
    const truncated = Object.values(bySource).some((s) => s?.truncated);
    return {
      data: out,
      meta: {
        returned: out.length,
        available,
        truncated,
        limit,
        bySource,
        lexical: lexicalMeta(lexCandidates, relaxedSources, queryVec !== null),
        scopeFilter: scopeFilterMeta(sources, docScopes, scopesDeclared),
      },
    };
  }

  /**
   * Reverse lookup: "what depends on this subject?" — lexical-only (no vector
   * lane, no embed call), and crosses doc-lane boundaries by flagging
   * out-of-lane hits instead of dropping them (filter-then-flag, vs recall's
   * filter-then-drop). See Store.impact's doc comment in contract.ts.
   */
  async impact(subject: string, opts?: ImpactOptions): Promise<ListResult<ImpactResult>> {
    const sources: SourceType[] = opts?.sources ?? ["fact", "session", "doc"];
    const limit = opts?.limit ?? 20;
    const laneN = Math.max(limit * 3, 20);
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

    const tableFor: Record<SourceType, string> = {
      fact: "facts",
      session: "sessions",
      doc: "docs",
    };

    const fused: FusedItem[] = [];
    const orderMeta = new Map<string, CandidateMeta>();
    const bySource: NonNullable<DeliveryMeta["bySource"]> = {};

    for (const st of sources) {
      const table = tableFor[st];
      const proj: SessionFilter | undefined =
        st === "session" ? { project: opts?.project } : undefined;
      // strict, and deliberately NOT `lexicalLaneWithFallback`: a dependency
      // tripwire must fire on the subject, not on resemblance to part of it.
      const lex = await this.lexicalLane(table, subject, proj, laneN);
      if (lex.length === 0) continue;
      const ids = lex.map((h) => h.id);

      let meta: Map<number, CandidateMeta>;
      if (st === "doc") {
        // Flag-mode fetch: NO scope predicate — unlike metaFor's recall-path
        // query, out-of-lane docs are kept (and flagged inScope:false below),
        // never dropped. This is the one place impact() diverges from recall's
        // scope-filtered metaFor query.
        meta = new Map<number, CandidateMeta>();
        const res = await this.pool.query(
          `select id, status, scope from ${this.q("docs")} where id = any($1)`,
          [ids],
        );
        for (const r of res.rows as Row[]) {
          const rowScope = String(r.scope);
          meta.set(Number(r.id), {
            sourceType: "doc",
            id: Number(r.id),
            active: String(r.status) === "active",
            scope: rowScope,
            inScope: declaredScopes.includes(rowScope),
          });
        }
      } else {
        // fact/session paths UNCHANGED — facts still filter status='active',
        // sessions unfiltered. Reused as-is from recall().
        meta = await this.metaFor(st, ids);
      }

      // Drop any lane hit whose id has no meta entry and re-rank so RRF ranks
      // stay dense — same idiom recall() uses for its fact/doc filtering.
      const lexFiltered = lex
        .filter((h) => meta.has(h.id))
        .map((h, i) => ({ id: h.id, rank: i }));

      const laneFused = fuseLane(st, [], lexFiltered, meta, impactCfg).slice(0, limit);
      for (const f of laneFused) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`${st}:${f.id}`, m);
      }
      bySource[st] = {
        returned: laneFused.length,
        available: meta.size,
        truncated: laneFused.length < meta.size || lex.length >= laneN,
      };
    }

    const ordered = orderResults(fused, orderMeta);
    const out: ImpactResult[] = [];
    for (const f of ordered) {
      const r = await this.toImpactResult(f, orderMeta);
      if (r) out.push(r);
    }
    const available = Object.values(bySource).reduce((sum, s) => sum + (s?.available ?? 0), 0);
    const truncated = Object.values(bySource).some((s) => s?.truncated);
    return {
      data: out,
      meta: {
        returned: out.length,
        available,
        truncated,
        limit,
        bySource,
      },
    };
  }

  private async toRecallResult(f: FusedItem): Promise<RecallResult | null> {
    if (f.sourceType === "fact") {
      const fact = await this.factsGet(f.id);
      if (!fact) return null;
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
      const s = await this.sessionsGet(f.id);
      if (!s) return null;
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
    const d = await this.docsGet(f.id);
    if (!d) return null;
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
    };
  }

  /**
   * Decorate a fused item into an ImpactResult by reusing toRecallResult and
   * adding the lane verdict. Facts/sessions are always in-scope/"global".
   * Out-of-lane docs keep everything except title/snippet, which are withheld.
   */
  private async toImpactResult(
    f: FusedItem,
    orderMeta: Map<string, CandidateMeta>,
  ): Promise<ImpactResult | null> {
    const r = await this.toRecallResult(f);
    if (!r) return null;
    if (f.sourceType !== "doc") {
      return { ...r, inScope: true, scope: "global" };
    }
    const m = orderMeta.get(`doc:${f.id}`);
    const scope = m?.scope ?? "global";
    if (m?.inScope === false) {
      return { ...r, title: null, snippet: null, inScope: false, scope };
    }
    return { ...r, inScope: true, scope };
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
    // Fetch 200, render `recentSessions`: same reason as the facts lane below.
    // At a fetch of 8 the sessions reserve never binds, so a truncated lane had
    // no ids to name and droppedItems came back empty while meta said
    // `truncated: true` — 42 sessions withheld silently (measured 2026-09-01).
    // engine/brief.ts caps the RENDERED list; the surplus exists to be named.
    const recentSessionsResult = await this.sessionsList({
      project: o.project,
      limit: Math.max(o.recentSessions ?? 8, 200),
    });
    // 200, not 30: facts 31+ must still be fetched or their ids can never be
    // named in droppedItems (the reserve truncation in engine/brief.ts).
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
    let storageOk = true;
    let storageDetail = "postgres + pgvector + tsvector";
    let counts = { facts: 0, sessions: 0, docs: 0, documents: 0, bytes: 0 };
    try {
      const f = await this.pool.query(`select count(*)::int c from ${this.q("facts")}`);
      const s = await this.pool.query(`select count(*)::int c from ${this.q("sessions")}`);
      const d = await this.pool.query(`select count(*)::int c from ${this.q("docs")}`);
      const dd = await this.pool.query(
        `select count(*)::int c from ${this.q("docs")} where chunk_idx = 0`,
      );
      // on-disk size (table + indexes + toast) of the grounded tables
      const b = await this.pool.query(
        `select coalesce(sum(pg_total_relation_size(c.oid)),0)::bigint b
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname in ('facts','sessions','docs')`,
        [this.schema],
      );
      counts = {
        facts: Number((f.rows[0] as Row).c),
        sessions: Number((s.rows[0] as Row).c),
        docs: Number((d.rows[0] as Row).c),
        documents: Number((dd.rows[0] as Row).c),
        bytes: Number((b.rows[0] as Row).b),
      };
    } catch (err) {
      storageOk = false;
      storageDetail = (err as Error).message;
    }
    const embHealth = await this.embedder.health();
    return {
      ok: storageOk && (embHealth.ok || !this.embedder.enabled),
      storage: {
        adapter: "postgres",
        ok: storageOk,
        detail: storageDetail,
        location: `${this.schema} schema`,
      },
      embeddings: {
        provider: this.embedder.id,
        ok: embHealth.ok,
        dims: this.embedder.dims,
        detail: embHealth.detail,
        model: this.cfg.embeddings.model,
      },
      counts,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function openPostgresStore(
  cfg: GroundedConfig,
  embedder: EmbeddingProvider,
): Promise<Store> {
  const store = new PostgresStore(cfg, embedder);
  await store.init();
  return store;
}
