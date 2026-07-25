import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import type { CloudConfig } from "./config.js";
import { migrateControlPlane } from "./migrate.js";
import { TokenManager } from "./tokens.js";
import { createGateway, type Gateway } from "./gateway.js";

const PG_URL = process.env.GROUNDED_TEST_PG_URL;

// Hardcoded, never sourced from env or config — the only thing standing between
// the DROP below and the live `grounded`/`accounts` schemas in the same database.
// Distinct from core's grounded_test/grounded_vec_test schemas on purpose.
const ACCOUNTS_SCHEMA = "cloud_gw_test_accounts";
const TENANT_SCHEMA = "cloud_gw_test_tenant";

function testConfig(): CloudConfig {
  if (!PG_URL) throw new Error("GROUNDED_TEST_PG_URL not set");
  return {
    baseUrl: "http://localhost:8088",
    host: "127.0.0.1",
    port: 8088,
    pgUrl: PG_URL,
    accountsSchema: ACCOUNTS_SCHEMA,
    tenantSchemaPrefix: "cloud_gw_test_tenant_unused_",
    tenantCacheMax: 10,
    authSecret: "test-secret-not-for-prod-0123456789",
    embeddings: { provider: "none", dims: 768 },
  };
}

describe.skipIf(!PG_URL)("gateway scope enforcement", () => {
  let pool: pg.Pool;
  let cfg: CloudConfig;
  let gateway: Gateway;
  let cabinetId: string;
  let rwSecret: string;
  let roSecret: string;
  let noReadSecret: string;

  beforeAll(async () => {
    cfg = testConfig();

    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    try {
      await admin.query(`drop schema if exists "${ACCOUNTS_SCHEMA}" cascade`);
      await admin.query(`drop schema if exists "${TENANT_SCHEMA}" cascade`);
    } finally {
      await admin.end();
    }

    pool = new pg.Pool({ connectionString: PG_URL, max: 5 });
    await migrateControlPlane(pool, cfg);

    // Provision a cabinet directly (bypassing TenantManager.provision, which
    // mints a random schema name) so the tenant schema is deterministic and
    // droppable by name.
    cabinetId = randomBytes(4).toString("hex");
    await pool.query(
      `insert into "${ACCOUNTS_SCHEMA}".cabinets (id, user_id, schema) values ($1, $2, $3)`,
      [cabinetId, `user-${cabinetId}`, TENANT_SCHEMA],
    );

    const tokens = new TokenManager(pool, cfg);
    rwSecret = (await tokens.issue(cabinetId, "rw", ["read", "write"])).secret;
    roSecret = (await tokens.issue(cabinetId, "ro", ["read"])).secret;
    noReadSecret = (await tokens.issue(cabinetId, "none", [])).secret;

    gateway = createGateway(pool, cfg);
  });

  afterAll(async () => {
    // Drop test schemas while the pool is still live, then let gateway.close()
    // tear down cached tenant stores + the pool itself.
    await pool.query(`drop schema if exists "${TENANT_SCHEMA}" cascade`);
    await pool.query(`drop schema if exists "${ACCOUNTS_SCHEMA}" cascade`);
    await gateway.close();
  });

  function req(method: string, path: string, secret: string, body?: unknown): Request {
    return new Request(`http://local.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("write-scoped token: POST passes the gateway scope check", async () => {
    const res = await gateway.app.fetch(req("POST", "/api/facts", rwSecret, { fact: "hello" }));
    // Not a 403 — the gateway let it through to the tenant API.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(201);
  });

  it("write-scoped token: GET also passes", async () => {
    const res = await gateway.app.fetch(req("GET", "/api/facts", rwSecret));
    expect(res.status).toBe(200);
  });

  it("read-only token: GET succeeds", async () => {
    const res = await gateway.app.fetch(req("GET", "/api/facts", roSecret));
    expect(res.status).toBe(200);
  });

  it.each(["POST", "PATCH", "PUT", "DELETE"])(
    "read-only token: %s is rejected 403 with the write-scope message",
    async (method) => {
      const res = await gateway.app.fetch(
        req(method, "/api/facts/1", roSecret, method === "DELETE" ? undefined : {}),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(body.error).toMatch(/write/);
    },
  );

  it.each(["GET", "POST", "PATCH", "PUT", "DELETE"])(
    "token missing read scope: %s is rejected 403 with the read-scope message",
    async (method) => {
      const res = await gateway.app.fetch(
        req(method, "/api/facts/1", noReadSecret, method === "GET" || method === "DELETE" ? undefined : {}),
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(body.error).toMatch(/read/);
    },
  );

  it("invalid token still yields 401 UNAUTHORIZED, not 403", async () => {
    const res = await gateway.app.fetch(req("GET", "/api/facts", "grnd_deadbeef_notreal"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
  });
});
