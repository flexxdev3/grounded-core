import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SCOPE_AFFINITY,
  DEFAULT_SCOPE_MISMATCH,
  DEFAULT_SCOPE_SPECIFICITY,
} from "./engine/recall.js";
import {
  CHARS_PER_TOK,
  LANE_BUDGETS,
  defaultConfig,
  loadConfig,
  resolveBudget,
  resolveLaneBudget,
} from "./config.js";

function withHome<T>(toml: string | null, fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "grounded-budget-cfg-"));
  try {
    if (toml !== null) writeFileSync(join(home, "config.toml"), toml, "utf8");
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The Context Budget Contract, item 1: ONE table. Every cap in the product is
// derived from `LANE_BUDGETS`; nothing else states a lane size. These tests
// pin the derivation, not the enforcement (that lives in the API suite).
// ---------------------------------------------------------------------------
describe("budget table: one source of truth for every lane cap", () => {
  it("derives both sides of every lane from one record", () => {
    const budget = resolveBudget(defaultConfig("/tmp/nowhere"));

    // vision: rows 1, so the per-row share IS the whole lane — which is why
    // vision's warn tier and its 400 tier are the same 1600 chars, unchanged
    // from the cap POST /vision has enforced since the write cap landed.
    expect(budget.vision.laneCapChars).toBe(400 * CHARS_PER_TOK);
    expect(budget.vision.rowCapChars).toBe(budget.vision.laneCapChars);
    expect(budget.vision.bodyCapChars).toBeNull();

    // facts: 3600-char lane over 8 delivered rows = a 450-char row share.
    expect(budget.facts.laneCapChars).toBe(3600);
    expect(budget.facts.rowCapChars).toBe(450);
    expect(budget.facts.indexTok).toBe(300);

    // sessions: the lane the table has to say something different about —
    // `summary` is brief-rendered and budgeted, `details` is never injected
    // and gets the lane's bodyFactor allowance instead.
    expect(budget.sessions.laneCapChars).toBe(2000);
    expect(budget.sessions.rowCapChars).toBe(250);
    expect(budget.sessions.briefField).toBe("summary");
    expect(budget.sessions.bodyField).toBe("details");
    expect(budget.sessions.bodyCapChars).toBe(2000 * LANE_BUDGETS.sessions.bodyFactor);
  });

  it("states the mirrors nowhere else: reserve and typicalFactLimit are projections", () => {
    const cfg = defaultConfig("/tmp/nowhere");
    expect(cfg.brief.reserve).toEqual({
      vision: LANE_BUDGETS.vision.reserveTok,
      facts: LANE_BUDGETS.facts.reserveTok,
      sessions: LANE_BUDGETS.sessions.reserveTok,
    });
    expect(cfg.delivery.typicalFactLimit).toBe(LANE_BUDGETS.facts.rows);
  });

  it("raising a lane raises its write cap and its read reserve together", () => {
    const tight = resolveLaneBudget("facts", { ...LANE_BUDGETS.facts, reserveTok: 100 });
    expect(tight.laneCapChars).toBe(400);
    expect(tight.rowCapChars).toBe(50);
    // The index tier does NOT shrink with the lane — its job is to catch what
    // a small lane spilled.
    expect(tight.indexTok).toBe(300);
  });

  it("honours a config.toml [brief.reserve] override on BOTH sides and keeps the mirrors in step", () => {
    const cfg = withHome("[brief.reserve]\nfacts = 1200\n", (home) => loadConfig({ home }));
    expect(cfg.brief.reserve.facts).toBe(1200);
    expect(cfg.brief.budget!.facts.reserveTok).toBe(1200);
    expect(resolveBudget(cfg).facts.laneCapChars).toBe(4800);
    expect(resolveBudget(cfg).facts.rowCapChars).toBe(600);
    // Untouched lanes keep the shipped table.
    expect(cfg.brief.reserve.vision).toBe(LANE_BUDGETS.vision.reserveTok);
  });

  it("honours a config.toml [brief.budget] override and re-projects reserve from it", () => {
    const cfg = withHome("[brief.budget.sessions]\nreserveTok = 250\nrows = 5\n", (home) =>
      loadConfig({ home }),
    );
    expect(cfg.brief.reserve.sessions).toBe(250);
    const budget = resolveBudget(cfg);
    expect(budget.sessions.laneCapChars).toBe(1000);
    expect(budget.sessions.rowCapChars).toBe(200);
    // bodyFactor was not overridden, so it still comes from the table.
    expect(budget.sessions.bodyCapChars).toBe(1000 * LANE_BUDGETS.sessions.bodyFactor);
  });

  it("keeps delivery.typicalFactLimit and the facts lane's row count from drifting apart", () => {
    const viaDelivery = withHome("[delivery]\ntypicalFactLimit = 5\n", (home) =>
      loadConfig({ home }),
    );
    expect(viaDelivery.delivery.typicalFactLimit).toBe(5);
    expect(resolveBudget(viaDelivery).facts.rows).toBe(5);
    // 3600 chars over 5 rows — the row share moves with the row count.
    expect(resolveBudget(viaDelivery).facts.rowCapChars).toBe(720);

    const viaBudget = withHome("[brief.budget.facts]\nrows = 4\n", (home) => loadConfig({ home }));
    expect(viaBudget.delivery.typicalFactLimit).toBe(4);
  });

  it("resolves a config that predates the table (reserve only, no budget key)", () => {
    const legacy = defaultConfig("/tmp/nowhere");
    delete legacy.brief.budget;
    legacy.brief.reserve.vision = 50;
    const budget = resolveBudget(legacy);
    expect(budget.vision.laneCapChars).toBe(200);
    expect(budget.facts.rowCapChars).toBe(450);
  });
});

// The scope-affinity tiers were shipped with their defaults hardcoded at the
// recall use site and merely optional in the config type — a knob the config
// claimed to own but no config.toml could reach.
describe("recall scope-affinity boosts are configurable, not just hardcoded", () => {
  it("puts the recall.ts defaults in the resolved config without restating them", () => {
    const cfg = defaultConfig("/tmp/nowhere");
    expect(cfg.recall.boosts.scopeAffinity).toBe(DEFAULT_SCOPE_AFFINITY);
    expect(cfg.recall.boosts.scopeMismatch).toBe(DEFAULT_SCOPE_MISMATCH);
    expect(cfg.recall.boosts.scopeSpecificity).toBe(DEFAULT_SCOPE_SPECIFICITY);
  });

  it("lets a config.toml disable one tier without disturbing the others", () => {
    const cfg = withHome("[recall.boosts]\nscopeSpecificity = 1.0\n", (home) =>
      loadConfig({ home }),
    );
    expect(cfg.recall.boosts.scopeSpecificity).toBe(1.0);
    expect(cfg.recall.boosts.scopeAffinity).toBe(DEFAULT_SCOPE_AFFINITY);
    expect(cfg.recall.boosts.pinned).toBe(defaultConfig("/tmp/nowhere").recall.boosts.pinned);
  });
});
