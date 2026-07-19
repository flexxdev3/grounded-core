import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defaultConfig } from "../config.js";
import { openStore } from "../store.js";
import type { GroundedConfig, Store } from "../contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

function sqliteConfig(home: string): GroundedConfig {
  const cfg = defaultConfig(home);
  cfg.storage.adapter = "sqlite";
  cfg.storage.path = join(home, "grounded.db");
  cfg.embeddings.provider = "none";
  cfg.embeddings.dims = 0;
  return cfg;
}

describe("Store lifecycle (sqlite, embeddings=none)", () => {
  let home: string;
  let store: Store;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-test-"));
    store = await openStore(sqliteConfig(home));
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("init + health reports lexical-only", async () => {
    const h = await store.health();
    expect(h.ok).toBe(true);
    expect(h.storage.adapter).toBe("sqlite");
    expect(h.embeddings.provider).toBe("none");
    expect(h.embeddings.dims).toBe(0);
  });

  it("facts: add / get / list / update / delete", async () => {
    const f = await store.factsAdd({
      fact: "never push to GitHub without explicit instruction",
      detail: "gh is authed to a public account",
      category: "commit-rule",
      pinned: true,
      importance: 1,
      topicKey: "no-push",
    });
    expect(f.id).toBeGreaterThan(0);
    expect(f.pinned).toBe(true);

    const got = await store.factsGet(f.id);
    expect(got?.fact).toBe(f.fact);

    const list = await store.factsList({ status: "active" });
    expect(list.some((x) => x.id === f.id)).toBe(true);

    const updated = await store.factsUpdate(f.id, {
      fact: "never push to any remote without explicit instruction",
    });
    expect(updated.id).toBe(f.id);
    expect(updated.fact).toBe("never push to any remote without explicit instruction");
    expect(updated.status).toBe("active");
    // untouched fields are preserved
    expect(updated.pinned).toBe(true);
    expect(updated.category).toBe("commit-rule");
    // exactly one row, still active
    const stillActive = await store.factsList({ status: "active" });
    expect(stillActive.filter((x) => x.id === f.id).length).toBe(1);

    const deleted = await store.factsDelete(f.id);
    expect(deleted).toBe(true);
    expect(await store.factsGet(f.id)).toBeNull();
  });

  it("sessions: add / list / timeline", async () => {
    const s1 = await store.sessionsAdd({
      summary: "built the sqlite adapter for grounded recall",
      details: "implemented hybrid recall with RRF fusion",
      project: "grounded",
    });
    const s2 = await store.sessionsAdd({
      summary: "wrote the embedding providers",
      project: "grounded",
    });
    expect(s1.id).toBeGreaterThan(0);

    const list = await store.sessionsList({ project: "grounded" });
    expect(list.length).toBeGreaterThanOrEqual(2);
    // newest first
    expect(list[0]!.id).toBe(s2.id);

    const tl = await store.sessionsTimeline({ around: s1.id, window: 2 });
    expect(tl.some((x) => x.id === s1.id)).toBe(true);

    const byQuery = await store.sessionsTimeline({ query: "embedding providers" });
    expect(byQuery.some((x) => x.id === s2.id)).toBe(true);
  });

  it("docs: ingest the examples folder, strips <private>", async () => {
    const report = await store.docsIngest([EXAMPLES], { source: "examples" });
    expect(report.scanned).toBeGreaterThan(0);
    expect(report.added).toBeGreaterThan(0);

    const docs = await store.docsList();
    expect(docs.length).toBeGreaterThan(0);
    const allBodies = docs.map((d) => d.body).join("\n");
    expect(allBodies).not.toMatch(/should be stripped/i);
    expect(allBodies).not.toMatch(/<private>/i);

    // idempotent re-ingest
    const again = await store.docsIngest([EXAMPLES], { source: "examples" });
    expect(again.added).toBe(0);
    expect(again.skipped).toBeGreaterThan(0);
  });

  it("recall: lexical-only returns cited cards, facts before docs, no private", async () => {
    await store.factsAdd({
      fact: "recall fuses vector and lexical lanes with RRF",
      category: "recall",
      importance: 0.5,
    });
    const results = await store.recall("recall lexical vector fusion");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.citation).toBeTruthy();
      expect(r.typedId).toMatch(/^(fact|session|doc):\d+$/);
      expect(r.matchedBy).toBe("lexical");
      expect(r.snippet).not.toMatch(/should be stripped/i);
    }
    // facts tier comes before docs tier
    const firstDoc = results.findIndex((r) => r.sourceType === "doc");
    const firstFact = results.findIndex((r) => r.sourceType === "fact");
    if (firstDoc >= 0 && firstFact >= 0) {
      expect(firstFact).toBeLessThan(firstDoc);
    }
  });

  it("get(typedId) returns full records", async () => {
    const results = await store.recall("recall fusion");
    expect(results.length).toBeGreaterThan(0);
    const first = results[0]!;
    const full = await store.get(first.typedId);
    expect(full).not.toBeNull();
    expect(full!.sourceType).toBe(first.sourceType);
  });

  it("brief: assembles startup context markdown", async () => {
    const brief = await store.brief({
      project: "grounded",
      query: "recall",
      format: "markdown",
    });
    expect(brief.startupNote).toBeTruthy();
    expect(brief.text).toContain("=== STARTUP CONTEXT ===");
    expect(brief.text).toContain("=== MOST RECENT WORK");
    expect(brief.text).toContain("=== DYNAMIC FACTS");
    expect(brief.recentSessions.length).toBeGreaterThan(0);
    // no vision set yet → section omitted entirely
    expect(brief.text).not.toContain("=== VISION");
  });

  it("brief: json format omits text", async () => {
    const brief = await store.brief({ format: "json" });
    expect(brief.text).toBeUndefined();
  });

  it("facts: scopes filter + brief excludes off-scope facts", async () => {
    await store.factsAdd({ fact: "in-project fact", scope: "project:alpha" });
    await store.factsAdd({ fact: "other-project fact", scope: "money" });

    // multi-scope list returns only the requested scopes
    const scoped = await store.factsList({
      status: "active",
      scopes: ["global", "project:alpha"],
    });
    const scopeSet = new Set(scoped.map((f) => f.scope));
    expect(scopeSet.has("project:alpha")).toBe(true);
    expect(scopeSet.has("money")).toBe(false);

    // brief scoped to project:alpha surfaces its fact, hides the off-scope one
    const brief = await store.brief({ project: "alpha", format: "markdown" });
    expect(brief.text).toContain("in-project fact");
    expect(brief.text).not.toContain("other-project fact");
    expect(brief.text).toContain("scope: global + project:alpha");
  });

  it("facts: machine scope is derived per-machine and does not leak across boxes", async () => {
    await store.factsAdd({ fact: "arch1-only fact", scope: "machine:arch1" });

    // a brief on arch1 derives machine:arch1 and surfaces the fact
    const onArch1 = await store.brief({ machine: "arch1", format: "markdown" });
    expect(onArch1.text).toContain("machine:arch1");
    expect(onArch1.text).toContain("arch1-only fact");

    // the same fact stays hidden from a brief on a different box
    const onOther = await store.brief({ machine: "gpuserv1", format: "markdown" });
    expect(onOther.text).not.toContain("arch1-only fact");
  });

  it("docsPrune marks missing nothing when files present", async () => {
    const res = await store.docsPrune();
    expect(res.missing).toBe(0);
  });

  it("vision: set / get / one record per scope, edited in place", async () => {
    const v1 = await store.visionSet({
      content: "Ship taste at scale without diluting the standard.",
    });
    expect(v1.scope).toBe("global");

    const got = await store.visionGet("global");
    expect(got?.id).toBe(v1.id);

    // set again → edits v1 in place, still exactly one row, same id
    const v2 = await store.visionSet({
      content: "Ship taste at scale. Design out front, engineering underneath.",
    });
    expect(v2.id).toBe(v1.id);
    expect(v2.content).toBe("Ship taste at scale. Design out front, engineering underneath.");
    const list = await store.visionList({ scope: "global" });
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(v1.id);

    // project vision is independent of global
    const pv = await store.visionSet({
      scope: "project:grounded",
      content: "Self-hosted continuity for multi-agent workspaces.",
    });
    expect((await store.visionGet("project:grounded"))?.id).toBe(pv.id);
    expect((await store.visionGet("global"))?.id).toBe(v2.id);
  });

  it("brief: renders VISION section (global + project) with the apply line", async () => {
    const brief = await store.brief({ project: "grounded", format: "markdown" });
    expect(brief.vision.global).not.toBeNull();
    expect(brief.vision.project?.scope).toBe("project:grounded");
    const text = brief.text!;
    expect(text).toContain("=== VISION (global · project:grounded) ===");
    expect(text).toContain("Design out front, engineering underneath.");
    expect(text).toContain("--- project:grounded ---");
    expect(text).toContain("Self-hosted continuity for multi-agent workspaces.");
    expect(text).toContain("Apply this: flag any plan, play, or design that conflicts");
    // order: VISION after STARTUP CONTEXT, before MOST RECENT WORK
    expect(text.indexOf("=== VISION")).toBeGreaterThan(text.indexOf("=== STARTUP CONTEXT ==="));
    expect(text.indexOf("=== VISION")).toBeLessThan(text.indexOf("=== MOST RECENT WORK"));

    // no project → global only, no divider
    const globalOnly = await store.brief({ format: "markdown" });
    expect(globalOnly.text).toContain("=== VISION (global) ===");
    expect(globalOnly.text).not.toContain("--- project:grounded ---");

    const deleted = await store.visionDelete(brief.vision.project!.id);
    expect(deleted).toBe(true);
    expect(await store.visionGet("project:grounded")).toBeNull();
  });
});
