import { randomBytes } from "node:crypto";
import type pg from "pg";
import { defaultConfig, openStore } from "@grounded/core";
import type { GroundedConfig, Store } from "@grounded/core/contract";
import type { CloudConfig } from "./config.js";

export interface Cabinet {
  id: string;
  userId: string;
  schema: string;
  plan: string;
  status: string;
  shard: string;
  createdAt: string;
}

function shortId(): string {
  // 8 hex chars — opaque, url-safe, collision-safe at our scale.
  return randomBytes(4).toString("hex");
}

function rowToCabinet(r: Record<string, unknown>): Cabinet {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    schema: r.schema as string,
    plan: r.plan as string,
    status: r.status as string,
    shard: r.shard as string,
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/**
 * Owns the mapping user → cabinet → tenant Store. Schema-per-tenant: each cabinet
 * is a Postgres schema, provisioned by a single openStore() call (the pg adapter
 * self-creates + migrates the schema). Live Stores are held in a bounded LRU so
 * we don't open a pool per request; the LRU also memoizes nothing else — the
 * gateway memoizes createApp() alongside (see gateway.ts).
 */
export class TenantManager {
  private readonly cache = new Map<string, Store>(); // schema -> Store (insertion-ordered = LRU)

  constructor(
    private readonly pool: pg.Pool,
    private readonly cfg: CloudConfig,
    private readonly onEvict?: (schema: string) => void,
  ) {}

  private tenantConfig(schema: string): GroundedConfig {
    const base = defaultConfig("/cloud");
    return {
      ...base,
      storage: { adapter: "postgres", url: this.cfg.pgUrl, schema },
      embeddings: { ...base.embeddings, ...this.cfg.embeddings },
    };
  }

  /** Get-or-open the live Store for a schema, refreshing its LRU position. */
  async storeForSchema(schema: string): Promise<Store> {
    const existing = this.cache.get(schema);
    if (existing) {
      this.cache.delete(schema);
      this.cache.set(schema, existing);
      return existing;
    }
    const store = await openStore(this.tenantConfig(schema)); // creates + migrates schema if new
    this.cache.set(schema, store);
    await this.evictExcess();
    return store;
  }

  private async evictExcess(): Promise<void> {
    while (this.cache.size > this.cfg.tenantCacheMax) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      const store = this.cache.get(oldest);
      this.cache.delete(oldest);
      this.onEvict?.(oldest);
      if (store) await store.close().catch(() => {});
    }
  }

  // ---- cabinet control-plane ----

  async cabinetByUser(userId: string): Promise<Cabinet | null> {
    const s = this.cfg.accountsSchema;
    const { rows } = await this.pool.query(`select * from "${s}".cabinets where user_id = $1`, [userId]);
    return rows[0] ? rowToCabinet(rows[0]) : null;
  }

  async cabinetById(id: string): Promise<Cabinet | null> {
    const s = this.cfg.accountsSchema;
    const { rows } = await this.pool.query(`select * from "${s}".cabinets where id = $1`, [id]);
    return rows[0] ? rowToCabinet(rows[0]) : null;
  }

  /** Provision a cabinet for a user (idempotent — returns the existing one if present). */
  async provision(userId: string): Promise<Cabinet> {
    const existing = await this.cabinetByUser(userId);
    if (existing) return existing;

    const id = shortId();
    const schema = `${this.cfg.tenantSchemaPrefix}${id}`;
    const s = this.cfg.accountsSchema;
    const { rows } = await this.pool.query(
      `insert into "${s}".cabinets (id, user_id, schema, shard)
       values ($1, $2, $3, $4) returning *`,
      [id, userId, schema, this.cfg.tenantSchemaPrefix ? "ovh" : "ovh"],
    );
    // Touch the store once to create + migrate the schema now (not lazily on first API call).
    await this.storeForSchema(schema);
    return rowToCabinet(rows[0]);
  }

  /** Delete a cabinet: drop its schema and remove control-plane rows. */
  async destroy(cabinet: Cabinet): Promise<void> {
    const cached = this.cache.get(cabinet.schema);
    if (cached) {
      this.cache.delete(cabinet.schema);
      await cached.close().catch(() => {});
    }
    await this.pool.query(`drop schema if exists "${cabinet.schema}" cascade`);
    const s = this.cfg.accountsSchema;
    await this.pool.query(`delete from "${s}".cabinets where id = $1`, [cabinet.id]);
  }

  async closeAll(): Promise<void> {
    for (const store of this.cache.values()) await store.close().catch(() => {});
    this.cache.clear();
  }
}
