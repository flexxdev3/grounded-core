import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { ConfigError } from "./contract.js";
import type { GroundedConfig } from "./contract.js";

export const CONFIG_FILENAME = "config.toml";

export function defaultConfig(home?: string): GroundedConfig {
  const resolvedHome = home ?? join(homedir(), ".grounded");
  return {
    home: resolvedHome,
    storage: {
      adapter: "sqlite",
      path: join(resolvedHome, "cabinet", "grounded.db"),
      schema: "public",
    },
    embeddings: {
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
      dims: 768,
    },
    recall: {
      rrfK: 60,
      sourceCaps: { fact: 10, session: 10, doc: 10 },
      boosts: {
        pinned: 1.5,
        importance: 1.0,
        recencyHalfLifeDays: 30,
        activeStatus: 1.25,
      },
    },
    ingest: {
      ignoreFile: ".groundignore",
      stripPrivate: true,
      stripFrontmatter: true,
      chunkChars: 1200,
      chunkOverlap: 150,
    },
    brief: {
      reserve: { vision: 400, facts: 900, sessions: 500 },
    },
    delivery: {
      typicalFactLimit: 8,
    },
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = (base as Record<string, unknown>)[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function readFileLayer(home: string): DeepPartial<GroundedConfig> {
  const path = join(home, CONFIG_FILENAME);
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`failed to read ${path}: ${(err as Error).message}`);
  }
  try {
    return parseToml(raw) as DeepPartial<GroundedConfig>;
  } catch (err) {
    throw new ConfigError(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

function envLayer(): DeepPartial<GroundedConfig> {
  const env = process.env;
  const layer: DeepPartial<GroundedConfig> = {};
  const storage: DeepPartial<GroundedConfig["storage"]> = {};
  const embeddings: DeepPartial<GroundedConfig["embeddings"]> = {};

  if (env.GROUNDED_STORAGE_ADAPTER) {
    storage.adapter = env.GROUNDED_STORAGE_ADAPTER as GroundedConfig["storage"]["adapter"];
  }
  if (env.GROUNDED_DB_URL) storage.url = env.GROUNDED_DB_URL;

  if (env.GROUNDED_EMBED_PROVIDER) {
    embeddings.provider = env.GROUNDED_EMBED_PROVIDER as GroundedConfig["embeddings"]["provider"];
  }
  if (env.GROUNDED_EMBED_BASEURL) embeddings.baseUrl = env.GROUNDED_EMBED_BASEURL;
  if (env.GROUNDED_EMBED_MODEL) embeddings.model = env.GROUNDED_EMBED_MODEL;
  if (env.GROUNDED_OPENAI_API_KEY) embeddings.apiKey = env.GROUNDED_OPENAI_API_KEY;

  if (Object.keys(storage).length) layer.storage = storage;
  if (Object.keys(embeddings).length) layer.embeddings = embeddings;
  return layer;
}

export function loadConfig(overrides?: Partial<GroundedConfig>): GroundedConfig {
  const home =
    overrides?.home ?? process.env.GROUNDED_HOME ?? join(homedir(), ".grounded");

  let cfg = defaultConfig(home);
  cfg = deepMerge(cfg, readFileLayer(home));
  cfg = deepMerge(cfg, envLayer());
  cfg = deepMerge(cfg, overrides ?? {});
  cfg.home = home;
  return cfg;
}
