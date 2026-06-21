import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
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
import { assembleBrief } from "../engine/brief.js";
import { walk } from "../ingest/walker.js";
import { stripPrivateBlocks } from "../ingest/private.js";
import { chunkText, deriveTitle } from "../ingest/chunk.js";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

/** FTS5 MATCH-safe query: quote each token, OR them together. */
function sanitizeFts(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
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
      supersededBy: r.superseded_by == null ? null : Number(r.superseded_by),
      createdBy: (r.created_by as string | null) ?? null,
      source: (r.source as string | null) ?? null,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  async factsAdd(input: FactInput): Promise<Fact> {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `insert into facts(scope, category, fact, detail, topic_key, pinned, importance, status, created_by, source, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        input.scope ?? "global",
        input.category ?? "",
        input.fact,
        input.detail ?? null,
        input.topicKey ?? null,
        input.pinned ? 1 : 0,
        input.importance ?? 0,
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

  async factsList(opts?: ListOptions): Promise<Fact[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.scope) {
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
    return rows.map((r) => this.rowToFact(r));
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

  async factsSupersede(oldId: number, replacement: FactInput): Promise<Fact> {
    const existing = await this.factsGet(oldId);
    if (!existing) throw new StoreError(`fact ${oldId} not found`);
    const created = await this.factsAdd({
      ...replacement,
      scope: replacement.scope ?? existing.scope,
      category: replacement.category ?? existing.category,
      topicKey: replacement.topicKey ?? existing.topicKey ?? undefined,
    });
    this.db
      .prepare(
        `update facts set status = 'superseded', superseded_by = ?, updated_at = ? where id = ?`,
      )
      .run(created.id, nowIso(), oldId);
    return created;
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

  async sessionsList(opts?: ListOptions): Promise<Session[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.project) {
      where.push("project = ?");
      params.push(opts.project);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(
        `select * from sessions ${whereSql} order by created_at desc, id desc limit ? offset ?`,
      )
      .all(...params, limit, offset) as Row[];
    return rows.map((r) => this.rowToSession(r));
  }

  async sessionsGet(id: number): Promise<Session | null> {
    const r = this.db.prepare(`select * from sessions where id = ?`).get(id) as
      | Row
      | undefined;
    return r ? this.rowToSession(r) : null;
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
      const ids = results.map((r) => r.id);
      const out: Session[] = [];
      for (const id of ids) {
        const s = await this.sessionsGet(id);
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
      mtime: (r.mtime as string | null) ?? null,
      status: String(r.status) as DocStatus,
      kind: (r.kind as string | null) ?? null,
      machine: (r.machine as string | null) ?? null,
      ingestedAt: String(r.ingested_at),
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
    const stripPrivate = this.cfg.ingest.stripPrivate;
    const ignoreFile = this.cfg.ingest.ignoreFile;

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
        const content = stripPrivate ? stripPrivateBlocks(raw) : raw;
        const title = deriveTitle(content, file.relPath);
        const chunks = chunkText(
          content,
          this.cfg.ingest.chunkChars,
          this.cfg.ingest.chunkOverlap,
        );
        if (chunks.length === 0) continue;
        const mtime = new Date(file.mtimeMs).toISOString();
        const docPath = file.absPath;

        const existing = this.db
          .prepare(`select id, chunk_idx, body_hash from docs where path = ?`)
          .all(docPath) as Row[];
        const existingByIdx = new Map<number, Row>();
        for (const e of existing) existingByIdx.set(Number(e.chunk_idx), e);

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
          const ingestedAt = nowIso();
          if (prev) {
            const id = Number(prev.id);
            this.db
              .prepare(
                `update docs set source=?, title=?, body=?, total_chunks=?, body_hash=?, mtime=?, status='active', kind=?, machine=?, ingested_at=? where id=?`,
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
                `insert into docs(source, path, title, body, chunk_idx, total_chunks, body_hash, mtime, status, kind, machine, ingested_at)
                 values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
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

  async docsList(opts?: ListOptions): Promise<Doc[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.status) {
      where.push("status = ?");
      params.push(opts.status);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(
        `select * from docs ${whereSql} order by path asc, chunk_idx asc limit ? offset ?`,
      )
      .all(...params, limit, offset) as Row[];
    return rows.map((r) => this.rowToDoc(r));
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

  private lexicalLane(
    ftsTable: string,
    mainTable: string,
    matchExpr: string,
    project: string | undefined,
    limit: number,
  ): LaneHit[] {
    if (!matchExpr) return [];
    let sql = `select f.rowid as id, bm25(${ftsTable}) as rank from ${ftsTable} f where ${ftsTable} match ?`;
    const params: unknown[] = [matchExpr];
    if (project && mainTable === "sessions") {
      sql = `select f.rowid as id, bm25(${ftsTable}) as rank from ${ftsTable} f join sessions m on m.id = f.rowid where ${ftsTable} match ? and m.project = ?`;
      params.push(project);
    }
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

  private vectorLane(
    vecTable: string,
    queryVec: number[] | null,
    limit: number,
  ): LaneHit[] {
    if (!queryVec || !this.vectorActive()) return [];
    let rows: Row[];
    try {
      rows = this.db
        .prepare(
          `select rowid as id, distance from ${vecTable} where embedding match ? and k = ? order by distance`,
        )
        .all(JSON.stringify(queryVec), limit) as Row[];
    } catch {
      return [];
    }
    return rows.map((r, i) => ({ id: Number(r.id), rank: i }));
  }

  private factsMeta(ids: number[]): Map<number, CandidateMeta> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `select id, pinned, importance from facts where id in (${placeholders})`,
      )
      .all(...ids) as Row[];
    for (const r of rows) {
      map.set(Number(r.id), {
        sourceType: "fact",
        id: Number(r.id),
        pinned: Number(r.pinned) === 1,
        importance: Number(r.importance),
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

  private docsMeta(ids: number[]): Map<number, CandidateMeta> {
    const map = new Map<number, CandidateMeta>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`select id, status from docs where id in (${placeholders})`)
      .all(...ids) as Row[];
    for (const r of rows) {
      map.set(Number(r.id), {
        sourceType: "doc",
        id: Number(r.id),
        active: String(r.status) === "active",
      });
    }
    return map;
  }

  async recall(query: string, opts?: RecallOptions): Promise<RecallResult[]> {
    const sources: SourceType[] = opts?.sources ?? ["fact", "session", "doc"];
    const limit = opts?.limit ?? 10;
    const laneN = Math.max(limit * 3, 20);
    const matchExpr = sanitizeFts(query);

    const wantVector =
      !opts?.lexicalOnly && this.vectorActive() && query.trim().length > 0;
    const queryVec = wantVector ? await this.embedOne(query) : null;

    const fused: FusedItem[] = [];
    const orderMeta = new Map<string, CandidateMeta>();

    if (sources.includes("fact")) {
      const vec = this.vectorLane("vec_facts", queryVec, laneN);
      const lex = this.lexicalLane(
        "fts_facts",
        "facts",
        matchExpr,
        undefined,
        laneN,
      );
      const ids = unionIds(vec, lex);
      const meta = this.factsMeta(ids);
      const out = fuseLane("fact", vec, lex, meta, this.cfg);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`fact:${f.id}`, m);
      }
    }

    if (sources.includes("session")) {
      const vec = this.vectorLane("vec_sessions", queryVec, laneN);
      const lex = this.lexicalLane(
        "fts_sessions",
        "sessions",
        matchExpr,
        opts?.project,
        laneN,
      );
      // when project filter set, restrict vector lane too
      const filteredVec = opts?.project
        ? this.filterSessionVecByProject(vec, opts.project)
        : vec;
      const ids = unionIds(filteredVec, lex);
      const meta = this.sessionsMeta(ids);
      const out = fuseLane("session", filteredVec, lex, meta, this.cfg);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`session:${f.id}`, m);
      }
    }

    if (sources.includes("doc")) {
      const vec = this.vectorLane("vec_docs", queryVec, laneN);
      const lex = this.lexicalLane("fts_docs", "docs", matchExpr, undefined, laneN);
      const ids = unionIds(vec, lex);
      const meta = this.docsMeta(ids);
      const out = fuseLane("doc", vec, lex, meta, this.cfg);
      for (const f of out) {
        fused.push(f);
        const m = meta.get(f.id);
        if (m) orderMeta.set(`doc:${f.id}`, m);
      }
    }

    const ordered = orderResults(fused, orderMeta).slice(0, limit);
    return ordered.map((f) => this.toRecallResult(f));
  }

  private filterSessionVecByProject(
    lane: LaneHit[],
    project: string,
  ): LaneHit[] {
    if (lane.length === 0) return lane;
    const ids = lane.map((h) => h.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `select id from sessions where id in (${placeholders}) and project = ?`,
      )
      .all(...ids, project) as Row[];
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
    const recentSessions = await this.sessionsList({
      project: o.project,
      limit: recentN,
    });
    const facts = await this.factsList({ status: "active", limit: 30 });
    let relatedDocs: RecallResult[] = [];
    const hint = o.query ?? o.cwd;
    if (hint) {
      relatedDocs = await this.recall(hint, { sources: ["doc"], limit: 5 });
    }
    return assembleBrief({ recentSessions, facts, relatedDocs }, o);
  }

  async health(): Promise<HealthReport> {
    const counts = {
      facts: (this.db.prepare(`select count(*) c from facts`).get() as Row).c as number,
      sessions: (this.db.prepare(`select count(*) c from sessions`).get() as Row)
        .c as number,
      docs: (this.db.prepare(`select count(*) c from docs`).get() as Row).c as number,
    };
    const embHealth = await this.embedder.health();
    return {
      ok: embHealth.ok || !this.embedder.enabled,
      storage: {
        adapter: "sqlite",
        ok: true,
        detail: this.vectorActive() ? "sqlite-vec + fts5" : "fts5 (lexical-only)",
      },
      embeddings: {
        provider: this.embedder.id,
        ok: embHealth.ok,
        dims: this.embedder.dims,
        detail: embHealth.detail,
      },
      counts: {
        facts: Number(counts.facts),
        sessions: Number(counts.sessions),
        docs: Number(counts.docs),
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
