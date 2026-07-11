import pg from "pg";
import pgvector from "pgvector/pg";
import { StoreError } from "../contract.js";
import type {
  BriefOptions,
  BriefResult,
  Doc,
  DocStatus,
  EmbeddingProvider,
  Fact,
  FactInput,
  FactStatus,
  FullRecord,
  GroundedConfig,
  HealthReport,
  IngestOptions,
  IngestReport,
  ListOptions,
  RecallOptions,
  RecallResult,
  Session,
  SessionInput,
  SourceType,
  Store,
  TimelineOptions,
  TypedId,
} from "../contract.js";
import {
  fuseLane,
  orderResults,
  type CandidateMeta,
  type FusedItem,
  type LaneHit,
} from "../engine/recall.js";
import { assembleBrief, deriveFactScopes } from "../engine/brief.js";
import { walk } from "../ingest/walker.js";
import { stripPrivateBlocks } from "../ingest/private.js";
import { chunkText, deriveTitle } from "../ingest/chunk.js";
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
      supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
      createdBy: (r.created_by as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  async factsAdd(input: FactInput): Promise<Fact> {
    const emb = await this.embedOne(`${input.fact}\n${input.detail ?? ""}`.trim());
    const res = await this.pool.query(
      `insert into ${this.q("facts")}(scope, category, fact, detail, topic_key, pinned, importance, status, created_by, source, embedding)
       values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10) returning *`,
      [
        input.scope ?? "global",
        input.category ?? "",
        input.fact,
        input.detail ?? null,
        input.topicKey ?? null,
        input.pinned ?? false,
        input.importance ?? 0,
        input.createdBy ?? null,
        input.source ?? null,
        emb ? pgvector.toSql(emb) : null,
      ],
    );
    return this.rowToFact(res.rows[0] as Row);
  }

  async factsList(opts?: ListOptions): Promise<Fact[]> {
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
    params.push(opts?.limit ?? 100);
    const limitIdx = params.length;
    params.push(opts?.offset ?? 0);
    const offsetIdx = params.length;
    const res = await this.pool.query(
      `select * from ${this.q("facts")} ${whereSql} order by pinned desc, importance desc, updated_at desc limit $${limitIdx} offset $${offsetIdx}`,
      params,
    );
    return (res.rows as Row[]).map((r) => this.rowToFact(r));
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

  async factsSupersede(oldId: number, replacement: FactInput): Promise<Fact> {
    const existing = await this.factsGet(oldId);
    if (!existing) throw new StoreError(`fact ${oldId} not found`);
    const created = await this.factsAdd({
      ...replacement,
      scope: replacement.scope ?? existing.scope,
      category: replacement.category ?? existing.category,
      topicKey: replacement.topicKey ?? existing.topicKey ?? undefined,
    });
    await this.pool.query(
      `update ${this.q("facts")} set status='superseded', superseded_by=$1, updated_at=now() where id=$2`,
      [created.id, oldId],
    );
    return created;
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

  async sessionsList(opts?: ListOptions): Promise<Session[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.project) {
      params.push(opts.project);
      where.push(`project = $${params.length}`);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    params.push(opts?.limit ?? 50);
    const limitIdx = params.length;
    params.push(opts?.offset ?? 0);
    const offsetIdx = params.length;
    const res = await this.pool.query(
      `select * from ${this.q("sessions")} ${whereSql} order by created_at desc, id desc limit $${limitIdx} offset $${offsetIdx}`,
      params,
    );
    return (res.rows as Row[]).map((r) => this.rowToSession(r));
  }

  async sessionsGet(id: number): Promise<Session | null> {
    const res = await this.pool.query(
      `select * from ${this.q("sessions")} where id = $1`,
      [id],
    );
    const r = res.rows[0] as Row | undefined;
    return r ? this.rowToSession(r) : null;
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
      for (const r of results) {
        const s = await this.sessionsGet(r.id);
        if (s) out.push(s);
      }
      return out;
    }
    return this.sessionsList({ project: opts.project, limit: window });
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
      ingestedAt: new Date(r.ingested_at as string).toISOString(),
    };
  }

  async docsIngest(rootPaths: string[], opts?: IngestOptions): Promise<IngestReport> {
    const report: IngestReport = {
      scanned: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      paths: [],
    };
    const source = opts?.source ?? "default";
    const kind = opts?.kind ?? "markdown";
    const machine = opts?.machine ?? null;
    const dryRun = opts?.dryRun ?? false;

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
        const content = this.cfg.ingest.stripPrivate ? stripPrivateBlocks(raw) : raw;
        const title = deriveTitle(content, file.relPath);
        const chunks = chunkText(
          content,
          this.cfg.ingest.chunkChars,
          this.cfg.ingest.chunkOverlap,
        );
        if (chunks.length === 0) continue;
        const mtime = new Date(file.mtimeMs).toISOString();
        const docPath = file.absPath;

        const existingRes = await this.pool.query(
          `select id, chunk_idx, body_hash from ${this.q("docs")} where path = $1`,
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
            report.skipped++;
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
              `update ${this.q("docs")} set source=$1, title=$2, body=$3, total_chunks=$4, body_hash=$5, mtime=$6, status='active', kind=$7, machine=$8, ingested_at=now(), embedding=$9 where id=$10`,
              [source, title, chunk.body, chunks.length, chunk.bodyHash, mtime, kind, machine, embSql, Number(prev.id)],
            );
            report.updated++;
          } else {
            await this.pool.query(
              `insert into ${this.q("docs")}(source, path, title, body, chunk_idx, total_chunks, body_hash, mtime, status, kind, machine, embedding)
               values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11)`,
              [source, docPath, title, chunk.body, chunk.idx, chunks.length, chunk.bodyHash, mtime, kind, machine, embSql],
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

  async docsList(opts?: ListOptions): Promise<Doc[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts?.documents) where.push("chunk_idx = 0");
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    params.push(opts?.limit ?? 100);
    const limitIdx = params.length;
    params.push(opts?.offset ?? 0);
    const offsetIdx = params.length;
    const res = await this.pool.query(
      `select * from ${this.q("docs")} ${whereSql} order by path asc, chunk_idx asc limit $${limitIdx} offset $${offsetIdx}`,
      params,
    );
    return (res.rows as Row[]).map((r) => this.rowToDoc(r));
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

  private async lexicalLane(
    table: string,
    query: string,
    project: string | undefined,
    limit: number,
  ): Promise<LaneHit[]> {
    if (!query.trim()) return [];
    const params: unknown[] = [query];
    let projSql = "";
    if (project && table === "sessions") {
      params.push(project);
      projSql = ` and project = $${params.length}`;
    }
    params.push(limit);
    const limitIdx = params.length;
    const sql = `select id, ts_rank_cd(search_tsv, websearch_to_tsquery('english', $1)) as rank
                 from ${this.q(table)}
                 where search_tsv @@ websearch_to_tsquery('english', $1)${projSql}
                 order by rank desc limit $${limitIdx}`;
    const res = await this.pool.query(sql, params);
    return (res.rows as Row[]).map((r, i) => ({ id: Number(r.id), rank: i }));
  }

  private async vectorLane(
    table: string,
    queryVec: number[] | null,
    project: string | undefined,
    limit: number,
  ): Promise<LaneHit[]> {
    if (!queryVec || !this.vectorActive()) return [];
    const params: unknown[] = [pgvector.toSql(queryVec)];
    let projSql = "where embedding is not null";
    if (project && table === "sessions") {
      params.push(project);
      projSql = `where embedding is not null and project = $${params.length}`;
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
  ): Promise<Map<number, CandidateMeta>> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    if (sourceType === "fact") {
      const res = await this.pool.query(
        `select id, pinned, importance from ${this.q("facts")} where id = any($1)`,
        [ids],
      );
      for (const r of res.rows as Row[]) {
        map.set(Number(r.id), {
          sourceType: "fact",
          id: Number(r.id),
          pinned: Boolean(r.pinned),
          importance: Number(r.importance),
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
      const res = await this.pool.query(
        `select id, status from ${this.q("docs")} where id = any($1)`,
        [ids],
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

  async recall(query: string, opts?: RecallOptions): Promise<RecallResult[]> {
    const sources: SourceType[] = opts?.sources ?? ["fact", "session", "doc"];
    const limit = opts?.limit ?? 10;
    const laneN = Math.max(limit * 3, 20);
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

    for (const st of sources) {
      const table = tableFor[st];
      const proj = st === "session" ? opts?.project : undefined;
      const vec = await this.vectorLane(table, queryVec, proj, laneN);
      const lex = await this.lexicalLane(table, query, proj, laneN);
      const ids = new Set<number>();
      for (const h of vec) ids.add(h.id);
      for (const h of lex) ids.add(h.id);
      const meta = await this.metaFor(st, [...ids]);
      const out = fuseLane(st, vec, lex, meta, this.cfg).slice(0, limit);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`${st}:${f.id}`, m);
      }
    }

    // Per-lane cap already applied above (each source contributes up to `limit`).
    // orderResults groups by source tier, each ranked within its lane — the live
    // system's sectioned model. No global truncation across sources.
    const ordered = orderResults(fused, orderMeta);
    const out: RecallResult[] = [];
    for (const f of ordered) {
      const r = await this.toRecallResult(f);
      if (r) out.push(r);
    }
    return out;
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
    const recentSessions = await this.sessionsList({
      project: o.project,
      limit: o.recentSessions ?? 8,
    });
    const facts = await this.factsList({
      status: "active",
      scopes: deriveFactScopes(o),
      limit: 30,
    });
    let relatedDocs: RecallResult[] = [];
    const hint = o.query ?? o.cwd;
    if (hint) {
      relatedDocs = await this.recall(hint, { sources: ["doc"], limit: 5 });
    }
    return assembleBrief({ recentSessions, facts, relatedDocs }, o);
  }

  async health(): Promise<HealthReport> {
    let storageOk = true;
    let storageDetail = "postgres + pgvector + tsvector";
    let counts = { facts: 0, sessions: 0, docs: 0, documents: 0 };
    try {
      const f = await this.pool.query(`select count(*)::int c from ${this.q("facts")}`);
      const s = await this.pool.query(`select count(*)::int c from ${this.q("sessions")}`);
      const d = await this.pool.query(`select count(*)::int c from ${this.q("docs")}`);
      const dd = await this.pool.query(
        `select count(*)::int c from ${this.q("docs")} where chunk_idx = 0`,
      );
      counts = {
        facts: Number((f.rows[0] as Row).c),
        sessions: Number((s.rows[0] as Row).c),
        docs: Number((d.rows[0] as Row).c),
        documents: Number((dd.rows[0] as Row).c),
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
