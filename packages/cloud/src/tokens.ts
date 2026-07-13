import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { CloudConfig } from "./config.js";

export interface ApiTokenRow {
  id: string;
  cabinetId: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface IssuedToken {
  row: ApiTokenRow;
  /** The full secret — shown ONCE at creation, never stored or recoverable. */
  secret: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function rowTo(r: Record<string, unknown>): ApiTokenRow {
  return {
    id: r.id as string,
    cabinetId: r.cabinet_id as string,
    name: r.name as string,
    prefix: r.prefix as string,
    scopes: (r.scopes as string[]) ?? [],
    lastUsedAt: r.last_used_at ? (r.last_used_at as Date).toISOString() : null,
    createdAt: (r.created_at as Date).toISOString(),
    revokedAt: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
  };
}

/**
 * API tokens = how a hosted user's agents (MCP/HTTP) reach their cabinet. Format
 * `grnd_<prefix>_<secret>`: `prefix` (8 hex) is stored plaintext for O(1) lookup +
 * UI display; only sha256(secret) is stored. Verification is constant-time.
 */
export class TokenManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly cfg: CloudConfig,
  ) {}

  private get schema(): string {
    return this.cfg.accountsSchema;
  }

  async issue(cabinetId: string, name: string, scopes = ["read", "write"]): Promise<IssuedToken> {
    const id = randomBytes(8).toString("hex");
    const prefix = randomBytes(4).toString("hex");
    const secretPart = randomBytes(24).toString("hex");
    const secret = `grnd_${prefix}_${secretPart}`;
    const { rows } = await this.pool.query(
      `insert into "${this.schema}".api_tokens (id, cabinet_id, name, token_hash, prefix, scopes)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [id, cabinetId, name, sha256(secretPart), prefix, scopes],
    );
    return { row: rowTo(rows[0]), secret };
  }

  async list(cabinetId: string): Promise<ApiTokenRow[]> {
    const { rows } = await this.pool.query(
      `select * from "${this.schema}".api_tokens where cabinet_id = $1 order by created_at desc`,
      [cabinetId],
    );
    return rows.map(rowTo);
  }

  async revoke(cabinetId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update "${this.schema}".api_tokens set revoked_at = now()
       where id = $1 and cabinet_id = $2 and revoked_at is null`,
      [id, cabinetId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Verify a presented `grnd_…` token → the owning cabinetId, or null. Touches last_used_at. */
  async verify(presented: string): Promise<{ cabinetId: string; scopes: string[] } | null> {
    const m = /^grnd_([0-9a-f]{8})_([0-9a-f]+)$/.exec(presented);
    if (!m) return null;
    const prefix = m[1];
    const secretPart = m[2];
    if (!prefix || !secretPart) return null;
    const { rows } = await this.pool.query(
      `select * from "${this.schema}".api_tokens where prefix = $1 and revoked_at is null`,
      [prefix],
    );
    const wanted = Buffer.from(sha256(secretPart), "hex");
    for (const r of rows) {
      const stored = Buffer.from(r.token_hash as string, "hex");
      if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) {
        // fire-and-forget touch; verification result doesn't depend on it
        void this.pool
          .query(`update "${this.schema}".api_tokens set last_used_at = now() where id = $1`, [r.id])
          .catch(() => {});
        return { cabinetId: r.cabinet_id as string, scopes: (r.scopes as string[]) ?? [] };
      }
    }
    return null;
  }
}
