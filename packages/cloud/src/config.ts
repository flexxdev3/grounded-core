/**
 * Cloud gateway configuration — all from the environment (12-factor; the OVH
 * deploy is a docker-compose with these set). No config file: the cloud layer
 * is a service, not a user-installed CLI.
 */

export interface CloudConfig {
  /** Public base URL the gateway is served at (better-auth callbacks, connect snippets). */
  baseUrl: string;
  /** Listen host/port. */
  host: string;
  port: number;
  /** Control-plane Postgres — also the DB that holds every tenant schema (one instance for OVH). */
  pgUrl: string;
  /** Schema that holds accounts/cabinets/api_tokens/usage (better-auth tables too). */
  accountsSchema: string;
  /** Prefix for per-tenant cabinet schemas: `${prefix}${cabinetId}`. */
  tenantSchemaPrefix: string;
  /** Max live tenant Stores kept hot in the LRU. */
  tenantCacheMax: number;
  /** better-auth secret (session signing). */
  authSecret: string;
  /** Optional GitHub OAuth. */
  github?: { clientId: string; clientSecret: string };
  /** Embeddings for every tenant cabinet (shared Ollama on OVH). */
  embeddings: { provider: "ollama" | "openai" | "none"; baseUrl?: string; model?: string; dims?: number; apiKey?: string };
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

export function loadCloudConfig(): CloudConfig {
  const github =
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }
      : undefined;

  return {
    baseUrl: process.env.CLOUD_BASE_URL ?? "http://localhost:8088",
    host: process.env.CLOUD_HOST ?? "127.0.0.1",
    port: Number(process.env.CLOUD_PORT ?? 8088),
    pgUrl: req("CLOUD_PG_URL"),
    accountsSchema: process.env.CLOUD_ACCOUNTS_SCHEMA ?? "accounts",
    tenantSchemaPrefix: process.env.CLOUD_TENANT_PREFIX ?? "grounded_",
    tenantCacheMax: Number(process.env.CLOUD_TENANT_CACHE_MAX ?? 200),
    authSecret: req("BETTER_AUTH_SECRET"),
    github,
    embeddings: {
      provider: (process.env.GROUNDED_EMBED_PROVIDER as CloudConfig["embeddings"]["provider"]) ?? "ollama",
      baseUrl: process.env.GROUNDED_EMBED_BASEURL ?? "http://localhost:11434",
      model: process.env.GROUNDED_EMBED_MODEL ?? "nomic-embed-text",
      dims: process.env.GROUNDED_EMBED_DIMS ? Number(process.env.GROUNDED_EMBED_DIMS) : 768,
      apiKey: process.env.GROUNDED_OPENAI_API_KEY,
    },
  };
}
