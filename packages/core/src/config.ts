import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { ConfigError } from "./contract.js";
// The scope-affinity multipliers are DEFINED at their use site in
// engine/recall.ts (where they are documented against the measured RRF noise
// band that justifies them) and imported here so `config.toml` can override
// them without the numbers existing in two places.
import {
  DEFAULT_SCOPE_AFFINITY,
  DEFAULT_SCOPE_MISMATCH,
  DEFAULT_SCOPE_SPECIFICITY,
} from "./engine/recall.js";
import type { GroundedConfig } from "./contract.js";

export const CONFIG_FILENAME = "config.toml";

// ---------------------------------------------------------------------------
// THE CONTEXT BUDGET CONTRACT — one table, every lane, both sides.
//
// Doctrine 3 budgets the startup window by RESERVATION: each lane gets a fixed
// share and truncates inside its own slice. That is the READ side. The WRITE
// side (what a caller may store) has to come from the SAME numbers, or the two
// drift — which is exactly how a 19k-char vision row survived while every brief
// silently delivered its first 1600 chars.
//
// So: `LANE_BUDGETS` below is the ONLY place a lane size is stated. Everything
// else in this codebase DERIVES:
//   - `GroundedConfig.brief.reserve.*`   <- reserveTok  (kept as a key for
//                                           config.toml back-compat)
//   - `GroundedConfig.delivery.typicalFactLimit` <- facts.rows
//   - `DEFAULT_RECENT_SESSIONS` (engine/brief.ts)  <- sessions.rows
//   - `FACTS_INDEX_MAX_TOK`     (engine/brief.ts)  <- facts.reserveTok * indexRatio
//   - every write cap on POST/PATCH /facts, /sessions, /vision
// No enforcer restates a number. Raising a lane here raises what may be
// written AND what may be delivered, together, in one edit.
// ---------------------------------------------------------------------------

/** chars-per-token approximation used for every budget in this file and in
 *  engine/brief.ts. No BPE dependency — the engine has no tokenizer and never
 *  will for this purpose. Lives here, not in brief.ts, because config.ts is
 *  the bottom of the import graph (brief.ts imports this module). */
export const CHARS_PER_TOK = 4;

export type BriefLane = "vision" | "facts" | "sessions";

/** The tunable half of a lane's budget — the part a `config.toml` may override.
 *  Field NAMES are not tunable and live in `LANE_FIELDS` below. */
export interface LaneBudget {
  /** read side: tokens (chars÷4) this lane may spend in one brief. */
  reserveTok: number;
  /** rows this lane is expected to DELIVER in one brief. Together with
   *  `reserveTok` this is what makes a per-row write cap derivable: a row that
   *  costs more than `laneCap / rows` is eating another row's slot. */
  rows: number;
  /** Multiple of the lane cap allowed for a body field the brief NEVER renders
   *  — today only `session.details`, which is a full work log and is
   *  legitimately far longer than anything the brief injects. 0 means the lane
   *  has no unrendered body and every stored char is brief-bound. This is how
   *  the table expresses "a session detail is longer than a fact" without a
   *  second, free-floating number somewhere else. */
  bodyFactor: number;
  /** Facts only: the index tier's own budget, in the same tokens-as-chars÷4
   *  unit. Facts that overflow the full-text reserve get a compressed
   *  `topicKey — detail` line inside this smaller budget instead of vanishing.
   *  Deliberately NOT a ratio of `reserveTok`: the tier's job is to keep a
   *  shrunken lane from silently swallowing facts whole, so it must not shrink
   *  with it. Stated here because the table is where lane sizes are stated —
   *  no enforcer restates it. */
  indexTok?: number;
}

/**
 * The shipped budget. THE numbers. Changing one here changes the write cap,
 * the read reserve, and the health conformance check in lockstep.
 *
 * Sized against the live corpus (measured 2026-09-02, 38 facts / 600 sessions /
 * 7 vision rows): no fact is over its 450-char row cap, 5 of 600 session
 * summaries are over 250 (so summaries WARN, they do not reject), and the
 * longest session details is 11,993 of an allowed 16,000.
 */
export const LANE_BUDGETS: Record<BriefLane, LaneBudget> = {
  // rows: 1 — vision is one row per scope and the whole reserve is its row, so
  // rowCap === laneCap === 1600 chars and the warn tier collapses into the
  // reject tier. That is the cap POST /vision has enforced since 30795e8.
  vision: { reserveTok: 400, rows: 1, bodyFactor: 0 },
  // rows: 8 mirrors the SessionStart hook's FACTS_LIMIT=8; typicalFactLimit is
  // derived from it rather than stated twice.
  facts: { reserveTok: 900, rows: 8, bodyFactor: 0, indexTok: 300 },
  // rows: 8 is DEFAULT_RECENT_SESSIONS. bodyFactor 8 covers `details`, which
  // the brief never injects (summary only) but the store does embed.
  sessions: { reserveTok: 500, rows: 8, bodyFactor: 8 },
};

/** Which stored field each lane's reserve actually pays for, and which body
 *  field it does NOT. Not configurable — this is the schema, not a policy. */
export const LANE_FIELDS: Record<BriefLane, { brief: string; body: string | null }> = {
  vision: { brief: "details", body: null },
  facts: { brief: "fact", body: null },
  sessions: { brief: "summary", body: "details" },
};

/** A lane budget with every derived number computed once. Enforcers take one
 *  of these; they never do the arithmetic themselves. */
export interface ResolvedLaneBudget {
  lane: BriefLane;
  /** the stored field whose chars the reserve pays for. */
  briefField: string;
  /** a stored field the brief never renders, or null. */
  bodyField: string | null;
  reserveTok: number;
  rows: number;
  /** the whole lane's char budget: `reserveTok * CHARS_PER_TOK`. A single row
   *  over this alone consumes the entire lane — a 400, on every lane. */
  laneCapChars: number;
  /** one row's fair share: `laneCapChars / rows`. Over it is a WARNING (the
   *  row still stores; it is just eating a neighbour's slot). On vision this
   *  equals `laneCapChars`, so vision's warn and reject tiers coincide. */
  rowCapChars: number;
  /** cap for `bodyField`, or null when the lane has no unrendered body. */
  bodyCapChars: number | null;
  /** facts index tier budget in tokens, or null. */
  indexTok: number | null;
}

export function resolveLaneBudget(lane: BriefLane, b: LaneBudget): ResolvedLaneBudget {
  const laneCapChars = Math.max(1, Math.round(b.reserveTok * CHARS_PER_TOK));
  const rows = Math.max(1, Math.floor(b.rows));
  return {
    lane,
    briefField: LANE_FIELDS[lane].brief,
    bodyField: LANE_FIELDS[lane].body,
    reserveTok: b.reserveTok,
    rows,
    laneCapChars,
    rowCapChars: Math.max(1, Math.floor(laneCapChars / rows)),
    bodyCapChars: b.bodyFactor > 0 ? laneCapChars * b.bodyFactor : null,
    indexTok: b.indexTok ?? null,
  };
}

export type ResolvedBudget = Record<BriefLane, ResolvedLaneBudget>;

/**
 * The resolved table for a config. This is the function every enforcer calls —
 * API request guards, the brief's lane truncation, `GET /health`'s published
 * table — so all three can only ever agree.
 *
 * Tolerates a config without `brief.budget` (an older `config.toml`, or a
 * hand-built object in a test): the lane reserves then come from
 * `brief.reserve.*` and everything else from `LANE_BUDGETS`.
 */
export function resolveBudget(cfg: GroundedConfig): ResolvedBudget {
  const out = {} as ResolvedBudget;
  for (const lane of Object.keys(LANE_BUDGETS) as BriefLane[]) {
    const base = LANE_BUDGETS[lane];
    const fromCfg = cfg.brief?.budget?.[lane];
    // `reserve` first, `budget.reserveTok` second. In a config from
    // `loadConfig` the two are reconciled and identical, so the order is moot;
    // it matters only for a config object mutated in place (tests, embedders),
    // where `brief.reserve.<lane>` is the documented knob people reach for and
    // must therefore keep working.
    const reserveTok = cfg.brief?.reserve?.[lane] ?? fromCfg?.reserveTok ?? base.reserveTok;
    const rows =
      fromCfg?.rows ??
      (lane === "facts" ? cfg.delivery?.typicalFactLimit ?? base.rows : base.rows);
    out[lane] = resolveLaneBudget(lane, {
      reserveTok,
      rows,
      bodyFactor: fromCfg?.bodyFactor ?? base.bodyFactor,
      ...(fromCfg?.indexTok ?? base.indexTok) !== undefined
        ? { indexTok: fromCfg?.indexTok ?? base.indexTok }
        : {},
    });
  }
  return out;
}

/** The back-compat mirror: `brief.reserve.*` is never authored independently,
 *  it is projected from the budget table. */
function reserveFromBudget(budget: Record<BriefLane, LaneBudget>): GroundedConfig["brief"]["reserve"] {
  return {
    vision: budget.vision.reserveTok,
    facts: budget.facts.reserveTok,
    sessions: budget.sessions.reserveTok,
  };
}

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
        // Scope affinity (fact lane). Present in the resolved config rather
        // than only as a fallback inside recall.ts, so `[recall.boosts]` in a
        // config.toml can actually reach them — set any to 1 to disable that
        // tier. Values come from recall.ts; they are not restated here.
        scopeAffinity: DEFAULT_SCOPE_AFFINITY,
        scopeMismatch: DEFAULT_SCOPE_MISMATCH,
        scopeSpecificity: DEFAULT_SCOPE_SPECIFICITY,
      },
    },
    ingest: {
      ignoreFile: ".groundignore",
      stripPrivate: true,
      stripFrontmatter: true,
      chunkChars: 1200,
      chunkOverlap: 150,
      projectSegment: "corpus",
    },
    brief: {
      // The table is the source; `reserve` is its projection, never typed out
      // a second time. A config.toml that sets [brief.reserve] still wins —
      // see reconcileBudget() in loadConfig.
      budget: structuredClone(LANE_BUDGETS),
      reserve: reserveFromBudget(LANE_BUDGETS),
      factCategoryFloors: { "commit-rule": 1, "convention": 2, "playbook": 1 },
    },
    delivery: {
      // Derived, not restated: the hook's FACTS_LIMIT=8 lives in the table as
      // the facts lane's delivered-row count.
      typicalFactLimit: LANE_BUDGETS.facts.rows,
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

/**
 * Make the budget table and its two back-compat mirrors agree, whichever one
 * the operator actually wrote.
 *
 * Precedence per lane: an explicit `[brief.budget.<lane>]` wins; otherwise an
 * explicit `[brief.reserve] <lane>` (the older key, still the documented one)
 * is folded INTO the table; then `reserve` and `delivery.typicalFactLimit` are
 * re-projected from the table so the resolved config can never carry two
 * different truths. `patch` is the merged user layers, used only to tell
 * "explicitly set" from "inherited the default".
 */
function reconcileBudget(cfg: GroundedConfig, patch: DeepPartial<GroundedConfig>): void {
  const patched = patch.brief as DeepPartial<GroundedConfig["brief"]> | undefined;
  const budget = (cfg.brief.budget ??= structuredClone(LANE_BUDGETS));
  for (const lane of Object.keys(LANE_BUDGETS) as BriefLane[]) {
    budget[lane] = { ...LANE_BUDGETS[lane], ...(budget[lane] ?? {}) };
    const explicitBudget = (patched?.budget as Record<string, { reserveTok?: number }> | undefined)?.[lane]
      ?.reserveTok;
    const explicitReserve = (patched?.reserve as Record<string, number> | undefined)?.[lane];
    if (explicitBudget === undefined && explicitReserve !== undefined) {
      budget[lane].reserveTok = explicitReserve;
    }
  }
  const explicitTypical = (patch.delivery as { typicalFactLimit?: number } | undefined)
    ?.typicalFactLimit;
  const explicitFactRows = (patched?.budget as Record<string, { rows?: number }> | undefined)?.facts
    ?.rows;
  if (explicitFactRows === undefined && explicitTypical !== undefined) {
    budget.facts.rows = explicitTypical;
  }
  cfg.brief.reserve = reserveFromBudget(budget);
  cfg.delivery.typicalFactLimit = budget.facts.rows;
}

export function loadConfig(overrides?: Partial<GroundedConfig>): GroundedConfig {
  const home =
    overrides?.home ?? process.env.GROUNDED_HOME ?? join(homedir(), ".grounded");

  const patch = deepMerge<DeepPartial<GroundedConfig>>(
    deepMerge<DeepPartial<GroundedConfig>>(readFileLayer(home), envLayer()),
    overrides ?? {},
  );

  let cfg = defaultConfig(home);
  cfg = deepMerge(cfg, patch);
  cfg.home = home;
  reconcileBudget(cfg, patch);
  return cfg;
}
