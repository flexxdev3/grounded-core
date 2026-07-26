import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStore } from "../store.js";
import { assembleBrief } from "../engine/brief.js";
import type { GroundedConfig, Store, StorageAdapter } from "../contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

export interface StoreSuiteCase {
  /** describe(`Store lifecycle (${label})`) */
  label: string;
  /** pg: drop+recreate schema · sqlite: mkdtemp */
  beforeSuite?: () => Promise<void>;
  /** read AFTER beforeSuite has run */
  makeConfig: () => GroundedConfig;
  /** sqlite: rmSync(home) */
  afterSuite?: () => Promise<void>;
  expected: { adapter: StorageAdapter; detail: RegExp };
  /** when true, the whole suite (and every test in it) is emitted via describe.skip */
  skip?: boolean;
}

export function runStoreSuite(kase: StoreSuiteCase): void {
  const d = kase.skip ? describe.skip : describe;
  d(`Store lifecycle (${kase.label})`, () => {
    let store: Store;

    beforeAll(async () => {
      if (kase.beforeSuite) await kase.beforeSuite();
      const cfg = kase.makeConfig();
      store = await openStore(cfg);
    });

    afterAll(async () => {
      await store.close();
      if (kase.afterSuite) await kase.afterSuite();
    });

    it("init + health reports lexical-only", async () => {
      const h = await store.health();
      expect(h.ok).toBe(true);
      expect(h.storage.adapter).toBe(kase.expected.adapter);
      expect(h.storage.detail).toMatch(kase.expected.detail);
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

      const list = (await store.factsList({ status: "active" })).data;
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
      const stillActive = (await store.factsList({ status: "active" })).data;
      expect(stillActive.filter((x) => x.id === f.id).length).toBe(1);

      const deleted = await store.factsDelete(f.id);
      expect(deleted).toBe(true);
      expect(await store.factsGet(f.id)).toBeNull();
    });

    it("facts: importance defaults to 0.6 when omitted", async () => {
      const f = await store.factsAdd({ fact: "a fact with no explicit importance" });
      expect(f.importance).toBe(0.6);
      await store.factsDelete(f.id);
    });

    it("facts: status can be set to archived on add, and flipped via update", async () => {
      const archived = await store.factsAdd({
        fact: "a fact created already archived",
        status: "archived",
      });
      expect(archived.status).toBe("archived");

      const active = await store.factsAdd({ fact: "a fact created active by default" });
      expect(active.status).toBe("active");

      const flipped = await store.factsUpdate(active.id, { status: "archived" });
      expect(flipped.status).toBe("archived");

      // updating an unrelated field leaves status untouched
      const restored = await store.factsUpdate(archived.id, { status: "active" });
      const touched = await store.factsUpdate(restored.id, { category: "misc" });
      expect(touched.status).toBe("active");

      await store.factsDelete(archived.id);
      await store.factsDelete(active.id);
    });

    it("facts: archived facts are excluded from factsList({status:'active'}), included in factsList({status:'archived'}), still reachable via factsGet", async () => {
      const f = await store.factsAdd({
        fact: "an archived fact for list filtering",
        status: "archived",
      });

      const activeList = (await store.factsList({ status: "active" })).data;
      expect(activeList.some((x) => x.id === f.id)).toBe(false);

      const archivedList = (await store.factsList({ status: "archived" })).data;
      expect(archivedList.some((x) => x.id === f.id)).toBe(true);

      const got = await store.factsGet(f.id);
      expect(got?.status).toBe("archived");

      await store.factsDelete(f.id);
    });

    it("recall: excludes archived facts, includes active facts with matching text", async () => {
      const uniqueToken = "zzqrecallexclusiontoken";
      const active = await store.factsAdd({
        fact: `active fact containing ${uniqueToken}`,
        category: "recall-exclusion-test",
      });
      const archived = await store.factsAdd({
        fact: `archived fact containing ${uniqueToken}`,
        category: "recall-exclusion-test",
        status: "archived",
      });

      const results = (await store.recall(uniqueToken, { sources: ["fact"], limit: 10 })).data;
      const ids = results.map((r) => r.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(archived.id);

      await store.factsDelete(active.id);
      await store.factsDelete(archived.id);
    });

    it("brief: excludes archived facts (regression guard — brief() hardcodes status:'active')", async () => {
      const uniqueToken = "zzqbrieftoken";
      const archived = await store.factsAdd({
        fact: `archived fact ${uniqueToken}`,
        status: "archived",
      });
      const brief = await store.brief({ format: "markdown" });
      expect(brief.text).not.toContain(uniqueToken);
      expect(brief.facts.some((f) => f.id === archived.id)).toBe(false);
      await store.factsDelete(archived.id);
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

      const list = (await store.sessionsList({ project: "grounded" })).data;
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

      const docs = (await store.docsList()).data;
      expect(docs.length).toBeGreaterThan(0);
      const allBodies = docs.map((d) => d.body).join("\n");
      expect(allBodies).not.toMatch(/should be stripped/i);
      expect(allBodies).not.toMatch(/<private>/i);

      // idempotent re-ingest
      const again = await store.docsIngest([EXAMPLES], { source: "examples" });
      expect(again.added).toBe(0);
      expect(again.skipped).toBeGreaterThan(0);
    });

    it("docs: strips YAML frontmatter from the indexed/embedded body", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-frontmatter-test-"));
      const fileContent =
        "---\n" +
        "type: note\n" +
        "status: active\n" +
        "scope: global\n" +
        "---\n" +
        "# Real Heading\n\n" +
        "some prose about frontmatter stripping for the search index.\n";
      writeFileSync(join(dir, "frontmatter-doc.md"), fileContent, "utf8");

      const report = await store.docsIngest([dir], { source: "frontmatter-test" });
      expect(report.added).toBeGreaterThan(0);

      const docs = (await store.docsList()).data;
      const ownDocs = docs.filter((d) => d.source === "frontmatter-test");
      expect(ownDocs.length).toBeGreaterThan(0);
      const chunk0 = ownDocs.find((d) => d.chunkIdx === 0);
      expect(chunk0).toBeTruthy();
      expect(chunk0!.body).not.toContain("type:");
      expect(chunk0!.body).not.toContain("scope:");
      expect(chunk0!.body).not.toContain("---");
      expect(chunk0!.title).toBe("Real Heading");

      const full = await store.get(`doc:${chunk0!.id}`);
      expect(full).not.toBeNull();

      // Clean up our own fixture: drop the dir, then prune the rows it left.
      // Leaving either behind would break the later docsPrune expectation.
      rmSync(dir, { recursive: true, force: true });
      const pruned = await store.docsPrune({ remove: true });
      expect(pruned.removed).toBeGreaterThan(0);
    });

    it("docs: ingest with no scope lands rows at scope 'global'", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-scope-default-test-"));
      writeFileSync(
        join(dir, "default-scope-doc.md"),
        "# Default Scope Doc\n\nzzqdefaultscopetoken prose with no explicit scope declared.\n",
        "utf8",
      );

      const report = await store.docsIngest([dir], { source: "default-scope-test" });
      expect(report.added).toBeGreaterThan(0);

      const docs = (await store.docsList({ source: "default-scope-test" })).data;
      expect(docs.length).toBeGreaterThan(0);
      for (const d of docs) expect(d.scope).toBe("global");

      rmSync(dir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("docs: recall leak test — an administration-scoped doc is invisible to a caller declaring no scopes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-scope-leak-test-"));
      writeFileSync(
        join(dir, "admin-lane-doc.md"),
        "# Admin Lane Doc\n\nzzqadminlanetoken money lane pricing positioning client work.\n",
        "utf8",
      );

      await store.docsIngest([dir], { source: "scope-leak-test", scope: "administration" });

      // Positive control FIRST: prove the doc landed and is lexically reachable.
      // Without this the negative assertion below passes just as happily when the
      // ingest silently failed or the token never matched anything.
      const scoped = (await store.recall("zzqadminlanetoken", {
        sources: ["doc"],
        scopes: ["administration"],
        limit: 10,
      })).data;
      expect(scoped.some((r) => r.snippet.includes("zzqadminlanetoken"))).toBe(true);

      const unscoped = (await store.recall("zzqadminlanetoken", { sources: ["doc"], limit: 10 })).data;
      expect(unscoped.some((r) => r.snippet.includes("zzqadminlanetoken"))).toBe(false);

      rmSync(dir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("docs: recall({scopes}) reaches an off-default lane; declaring both lanes returns both", async () => {
      const globalDir = mkdtempSync(join(tmpdir(), "grounded-scope-global-test-"));
      const adminDir = mkdtempSync(join(tmpdir(), "grounded-scope-admin-test-"));
      writeFileSync(
        join(globalDir, "global-lane-doc.md"),
        "# Global Lane Doc\n\nzzqscopematrixtoken engineering corpus prose.\n",
        "utf8",
      );
      writeFileSync(
        join(adminDir, "admin-lane-doc2.md"),
        "# Admin Lane Doc Two\n\nzzqscopematrixtoken administration business prose.\n",
        "utf8",
      );

      await store.docsIngest([globalDir], { source: "scope-matrix-test" });
      await store.docsIngest([adminDir], { source: "scope-matrix-test", scope: "administration" });

      const adminOnly = (await store.recall("zzqscopematrixtoken", {
        sources: ["doc"],
        scopes: ["administration"],
        limit: 10,
      })).data;
      expect(adminOnly.some((r) => r.snippet.includes("zzqscopematrixtoken"))).toBe(true);

      const both = (await store.recall("zzqscopematrixtoken", {
        sources: ["doc"],
        scopes: ["global", "administration"],
        limit: 10,
      })).data;
      const bothPaths = new Set(
        both.filter((r) => r.sourceType === "doc").map((r) => r.citation),
      );
      expect(both.length).toBeGreaterThanOrEqual(2);
      expect(bothPaths.size).toBeGreaterThanOrEqual(2);

      rmSync(globalDir, { recursive: true, force: true });
      rmSync(adminDir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("docs: re-ingesting unchanged files with a different scope runs a tag-only retag, not an update", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-retag-test-"));
      writeFileSync(
        join(dir, "retag-doc.md"),
        "# Retag Doc\n\nzzqretagtoken content that never changes across re-ingests.\n",
        "utf8",
      );

      const first = await store.docsIngest([dir], { source: "retag-test" });
      expect(first.added).toBeGreaterThan(0);

      const before = (await store.docsList({ source: "retag-test" })).data;
      const hashBefore = new Map(before.map((d) => [d.id, d.bodyHash]));

      const second = await store.docsIngest([dir], {
        source: "retag-test",
        scope: "administration",
      });
      expect(second.retagged).toBeGreaterThan(0);
      expect(second.updated).toBe(0);
      expect(second.added).toBe(0);

      const after = (await store.docsList({ source: "retag-test" })).data;
      expect(after.length).toBe(before.length);
      for (const d of after) {
        expect(d.scope).toBe("administration");
        expect(d.bodyHash).toBe(hashBefore.get(d.id));
      }

      rmSync(dir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("docs: dryRun reports retagged without mutating any row", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-retag-dryrun-test-"));
      writeFileSync(
        join(dir, "retag-dryrun-doc.md"),
        "# Retag Dryrun Doc\n\nzzqretagdryruntoken stable content for dry-run retag check.\n",
        "utf8",
      );

      await store.docsIngest([dir], { source: "retag-dryrun-test" });
      const before = (await store.docsList({ source: "retag-dryrun-test" })).data;
      const scopeBefore = before.map((d) => d.scope);
      expect(scopeBefore.every((s) => s === "global")).toBe(true);

      const dry = await store.docsIngest([dir], {
        source: "retag-dryrun-test",
        scope: "administration",
        dryRun: true,
      });
      expect(dry.retagged).toBeGreaterThan(0);

      const after = (await store.docsList({ source: "retag-dryrun-test" })).data;
      for (const d of after) expect(d.scope).toBe("global");

      rmSync(dir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("brief: related-docs excludes off-scope docs by default, includes them via docScopes", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-brief-scope-test-"));
      writeFileSync(
        join(dir, "brief-admin-doc.md"),
        "# Brief Admin Doc\n\nzzqbriefscopetoken money lane pricing positioning client work.\n",
        "utf8",
      );
      await store.docsIngest([dir], { source: "brief-scope-test", scope: "administration" });

      const defaultBrief = await store.brief({
        query: "zzqbriefscopetoken money lane pricing positioning client work",
        format: "markdown",
      });
      expect(defaultBrief.text).not.toContain("zzqbriefscopetoken");

      const scopedBrief = await store.brief({
        query: "zzqbriefscopetoken money lane pricing positioning client work",
        docScopes: ["global", "administration"],
        format: "markdown",
      });
      expect(scopedBrief.text).toContain("zzqbriefscopetoken");

      rmSync(dir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("docsList: source and scope filter independently; no options returns every lane", async () => {
      const dirA = mkdtempSync(join(tmpdir(), "grounded-list-a-test-"));
      const dirB = mkdtempSync(join(tmpdir(), "grounded-list-b-test-"));
      writeFileSync(
        join(dirA, "list-a-doc.md"),
        "# List A Doc\n\nzzqlistfiltertoken lane-a content.\n",
        "utf8",
      );
      writeFileSync(
        join(dirB, "list-b-doc.md"),
        "# List B Doc\n\nzzqlistfiltertoken lane-b content.\n",
        "utf8",
      );

      await store.docsIngest([dirA], { source: "list-source-a", scope: "global" });
      await store.docsIngest([dirB], { source: "list-source-b", scope: "administration" });

      const bySource = (await store.docsList({ source: "list-source-a" })).data;
      expect(bySource.length).toBeGreaterThan(0);
      expect(bySource.every((d) => d.source === "list-source-a")).toBe(true);

      const byScope = (await store.docsList({ scope: "administration" })).data;
      expect(byScope.length).toBeGreaterThan(0);
      expect(byScope.every((d) => d.scope === "administration")).toBe(true);
      expect(byScope.some((d) => d.source === "list-source-b")).toBe(true);

      const unfiltered = (await store.docsList()).data;
      const unfilteredSources = new Set(unfiltered.map((d) => d.source));
      expect(unfilteredSources.has("list-source-a")).toBe(true);
      expect(unfilteredSources.has("list-source-b")).toBe(true);

      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("recall: lexical-only returns cited cards, facts before docs, no private", async () => {
      await store.factsAdd({
        fact: "recall fuses vector and lexical lanes with RRF",
        category: "recall",
        importance: 0.5,
      });
      const results = (await store.recall("recall lexical vector fusion")).data;
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
      const results = (await store.recall("recall fusion")).data;
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
      const scoped = (await store.factsList({
        status: "active",
        scopes: ["global", "project:alpha"],
      })).data;
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

    it("docsPrune with remove:true deletes rows for a file removed from disk", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-prune-remove-test-"));
      writeFileSync(
        join(dir, "prune-remove-doc.md"),
        "# Prune Remove Doc\n\nzzqpruneremovetoken content to be deleted from disk.\n",
        "utf8",
      );

      const report = await store.docsIngest([dir], { source: "prune-remove-test" });
      expect(report.added).toBeGreaterThan(0);

      const before = (await store.docsList({ source: "prune-remove-test" })).data;
      expect(before.length).toBeGreaterThan(0);

      // delete the file itself, not the tmp dir, so the path the row stores
      // is unambiguously gone but the parent dir still exists for cleanup.
      rmSync(join(dir, "prune-remove-doc.md"));

      const pruned = await store.docsPrune({ remove: true });
      expect(pruned.removed).toBeGreaterThanOrEqual(before.length);

      const after = (await store.docsList({ source: "prune-remove-test" })).data;
      expect(after.length).toBe(0);

      rmSync(dir, { recursive: true, force: true });
    });

    it("vision: set / get / one record per scope, edited in place", async () => {
      const v1 = await store.visionSet({
        details: "Ship taste at scale without diluting the standard.",
      });
      expect(v1.scope).toBe("global");

      const got = await store.visionGet("global");
      expect(got?.id).toBe(v1.id);

      // set again → edits v1 in place, still exactly one row, same id
      const v2 = await store.visionSet({
        details: "Ship taste at scale. Design out front, engineering underneath.",
      });
      expect(v2.id).toBe(v1.id);
      expect(v2.details).toBe("Ship taste at scale. Design out front, engineering underneath.");
      const list = (await store.visionList({ scope: "global" })).data;
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe(v1.id);

      // project vision is independent of global
      const pv = await store.visionSet({
        scope: "project:grounded",
        details: "Self-hosted continuity for multi-agent workspaces.",
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

    // -----------------------------------------------------------------
    // Delivery accounting (stage 2): `available`/`truncated` must be real
    // computed quantities, never derived from data.length. Every test below
    // is written to fail against a `data.length` fake — see each comment.
    // -----------------------------------------------------------------

    it("factsList: honest available — a data.length fake reports 5, not 15", async () => {
      const scope = "test:available-honesty";
      const ids: number[] = [];
      for (let i = 0; i < 15; i++) {
        const f = await store.factsAdd({ fact: `available-honesty fact ${i}`, scope });
        ids.push(f.id);
      }

      const page = await store.factsList({ scope, limit: 5 });
      expect(page.data.length).toBe(5);
      expect(page.meta.returned).toBe(5);
      expect(page.meta.available).toBe(15);
      expect(page.meta.truncated).toBe(true);

      for (const id of ids) await store.factsDelete(id);
    });

    it("factsList: available respects offset — page 2 of 3 (rows 10-15) is not truncated", async () => {
      const scope = "test:available-offset";
      const ids: number[] = [];
      for (let i = 0; i < 15; i++) {
        const f = await store.factsAdd({ fact: `available-offset fact ${i}`, scope });
        ids.push(f.id);
      }

      const lastPage = await store.factsList({ scope, limit: 5, offset: 10 });
      expect(lastPage.data.length).toBe(5);
      expect(lastPage.meta.available).toBe(15);
      // offset(10) + returned(5) === available(15): nothing left unseen.
      expect(lastPage.meta.truncated).toBe(false);

      for (const id of ids) await store.factsDelete(id);
    });

    it("recall: bySource.fact is honest when sourceCaps saturates without saturating laneN", async () => {
      const uniqueToken = "zzqbysourcehonestytoken";
      const scope = "test:bysource-honesty";
      const ids: number[] = [];
      // 15 matching facts: more than the default sourceCaps.fact (10), well
      // under laneN (max(limit*3,20) = 30 at the default limit of 10) — the
      // saturation here is the fuse-cap, not the lane-candidate floor.
      for (let i = 0; i < 15; i++) {
        const f = await store.factsAdd({
          fact: `${uniqueToken} candidate ${i}`,
          scope,
          importance: 0.5,
        });
        ids.push(f.id);
      }

      const result = await store.recall(uniqueToken, { sources: ["fact"] });
      const factMeta = result.meta.bySource?.fact;
      expect(factMeta).toBeDefined();
      // Real post-scope-filter match count, not `returned` (capped at 10 by
      // sourceCaps.fact). A `returned`-derived fake would report 10 here.
      expect(factMeta!.available).toBe(15);
      expect(factMeta!.returned).toBeLessThanOrEqual(10);
      expect(factMeta!.truncated).toBe(true);

      for (const id of ids) await store.factsDelete(id);
    });

    it("recall: truncated stays true when laneN itself is saturated, even though sourceCaps would otherwise look like the whole story", async () => {
      const uniqueToken = "zzqlanesaturationtoken";
      const scope = "test:lane-saturation";
      const limit = 2;
      const laneN = Math.max(limit * 3, 20); // 20 at this limit
      const seedCount = laneN + 10; // strictly more than the lane can even fetch
      const ids: number[] = [];
      for (let i = 0; i < seedCount; i++) {
        const f = await store.factsAdd({
          fact: `${uniqueToken} candidate ${i}`,
          scope,
          importance: 0.5,
        });
        ids.push(f.id);
      }

      const result = await store.recall(uniqueToken, { sources: ["fact"], limit });
      const factMeta = result.meta.bySource?.fact;
      expect(factMeta).toBeDefined();
      // `available` is a documented FLOOR here (meta.size can never exceed
      // laneN) — strictly less than the true seeded population, proving this
      // isn't silently reporting the real count.
      expect(factMeta!.available).toBeLessThan(seedCount);
      expect(factMeta!.truncated).toBe(true);

      for (const id of ids) await store.factsDelete(id);
    });

    it("factsDeliveryRank: top pinned/importance ranks 1, lowest ranks N; archived and missing return null", async () => {
      const scope = "test:delivery-rank";
      const low = await store.factsAdd({ fact: "rank low", scope, importance: 0.1 });
      const mid = await store.factsAdd({ fact: "rank mid", scope, importance: 0.5 });
      const top = await store.factsAdd({ fact: "rank top", scope, pinned: true, importance: 0.9 });
      const archived = await store.factsAdd({
        fact: "rank archived",
        scope,
        status: "archived",
      });

      const topRank = await store.factsDeliveryRank(top.id);
      expect(topRank).not.toBeNull();
      expect(topRank!.rank).toBe(1);
      expect(topRank!.ofActive).toBe(3);

      const lowRank = await store.factsDeliveryRank(low.id);
      expect(lowRank).not.toBeNull();
      expect(lowRank!.rank).toBe(3);
      expect(lowRank!.ofActive).toBe(3);

      const midRank = await store.factsDeliveryRank(mid.id);
      expect(midRank!.rank).toBe(2);

      expect(await store.factsDeliveryRank(archived.id)).toBeNull();
      expect(await store.factsDeliveryRank(-1)).toBeNull();

      await store.factsDelete(low.id);
      await store.factsDelete(mid.id);
      await store.factsDelete(top.id);
      await store.factsDelete(archived.id);
    });

    it("factsUpdate: createdBy round-trips when patched explicitly", async () => {
      const f = await store.factsAdd({ fact: "createdBy round-trip fact", createdBy: "alice" });
      expect(f.createdBy).toBe("alice");

      const updated = await store.factsUpdate(f.id, { createdBy: "bob" });
      expect(updated.createdBy).toBe("bob");

      const refetched = await store.factsGet(f.id);
      expect(refetched?.createdBy).toBe("bob");

      await store.factsDelete(f.id);
    });

    it("factsAdd: upsert on (scope, topicKey) is MERGE-PATCH, not full replacement", async () => {
      const scope = "test:upsert-merge-patch";
      const original = await store.factsAdd({
        fact: "original fact text",
        scope,
        topicKey: "merge-patch-key",
        pinned: true,
        importance: 0.9,
        category: "x",
      });
      expect(original.pinned).toBe(true);
      expect(original.importance).toBe(0.9);
      expect(original.category).toBe("x");

      // Re-add through the same (scope, topicKey), supplying ONLY fact + topicKey.
      // A full-replacement implementation resets pinned/importance/category to
      // their insert-time defaults here — that is exactly what this asserts against.
      const upserted = await store.factsAdd({
        fact: "updated fact text",
        scope,
        topicKey: "merge-patch-key",
      });
      expect(upserted.id).toBe(original.id);
      expect(upserted.fact).toBe("updated fact text");
      expect(upserted.pinned).toBe(true);
      expect(upserted.importance).toBe(0.9);
      expect(upserted.category).toBe("x");

      await store.factsDelete(original.id);
    });

    it("factsAdd: upsert does not duplicate — exactly one active row holds the (scope, topicKey)", async () => {
      const scope = "test:upsert-no-duplicate";
      const first = await store.factsAdd({
        fact: "first write",
        scope,
        topicKey: "no-dup-key",
      });
      const second = await store.factsAdd({
        fact: "second write, same key",
        scope,
        topicKey: "no-dup-key",
      });
      expect(second.id).toBe(first.id);

      const active = (await store.factsList({ scope, status: "active" })).data;
      const holders = active.filter((f) => f.topicKey === "no-dup-key");
      expect(holders.length).toBe(1);
      expect(holders[0].id).toBe(first.id);

      await store.factsDelete(first.id);
    });

    it("factsAdd: the same topicKey in a different scope is a separate row, never a collision", async () => {
      const keyName = "shared-key-cross-scope";
      const a = await store.factsAdd({
        fact: "scope A holds this key",
        scope: "test:upsert-scope-a",
        topicKey: keyName,
      });
      const b = await store.factsAdd({
        fact: "scope B holds this key",
        scope: "test:upsert-scope-b",
        topicKey: keyName,
      });
      expect(b.id).not.toBe(a.id);

      const refetchedA = await store.factsGet(a.id);
      expect(refetchedA?.fact).toBe("scope A holds this key");
      const refetchedB = await store.factsGet(b.id);
      expect(refetchedB?.fact).toBe("scope B holds this key");

      await store.factsDelete(a.id);
      await store.factsDelete(b.id);
    });

    it("factsAdd: re-adding a key held only by an archived row creates a fresh active row, archived row untouched", async () => {
      const scope = "test:upsert-archived-exemption";
      const original = await store.factsAdd({
        fact: "will be archived",
        scope,
        topicKey: "archived-exemption-key",
      });
      const archived = await store.factsUpdate(original.id, { status: "archived" });
      expect(archived.status).toBe("archived");

      const reAdded = await store.factsAdd({
        fact: "fresh active row claiming the freed key",
        scope,
        topicKey: "archived-exemption-key",
      });
      expect(reAdded.id).not.toBe(original.id);
      expect(reAdded.status).toBe("active");

      const stillArchived = await store.factsGet(original.id);
      expect(stillArchived?.status).toBe("archived");
      expect(stillArchived?.fact).toBe("will be archived");
      expect(stillArchived?.topicKey).toBe("archived-exemption-key");

      await store.factsDelete(original.id);
      await store.factsDelete(reAdded.id);
    });

    it("factsUpdate: un-archiving into a key an ACTIVE row already holds throws, and both rows survive unchanged", async () => {
      const scope = "test:upsert-unarchive-collision";
      const active = await store.factsAdd({
        fact: "active row holding the key",
        scope,
        topicKey: "unarchive-collision-key",
      });
      const archived = await store.factsAdd({
        fact: "archived row that will try to reclaim the key",
        scope,
        topicKey: "unarchive-collision-key",
        status: "archived",
      });
      // both rows may share the key while one is archived — the partial index
      // only constrains active rows, so this setup itself is legal.
      expect(active.topicKey).toBe("unarchive-collision-key");
      expect(archived.topicKey).toBe("unarchive-collision-key");

      await expect(
        store.factsUpdate(archived.id, { status: "active" }),
      ).rejects.toThrow();

      // the failure must not have half-applied — both rows unchanged.
      const activeAfter = await store.factsGet(active.id);
      expect(activeAfter?.status).toBe("active");
      expect(activeAfter?.fact).toBe("active row holding the key");
      const archivedAfter = await store.factsGet(archived.id);
      expect(archivedAfter?.status).toBe("archived");
      expect(archivedAfter?.fact).toBe("archived row that will try to reclaim the key");

      await store.factsDelete(active.id);
      await store.factsDelete(archived.id);
    });

    it("facts: origin defaults to 'stated', accepts explicit 'derived', and round-trips through factsList/factsGet", async () => {
      const scope = "test:origin-roundtrip";
      const defaulted = await store.factsAdd({ fact: "no origin specified", scope });
      expect(defaulted.origin).toBe("stated");

      const derived = await store.factsAdd({
        fact: "explicitly derived fact",
        scope,
        origin: "derived",
      });
      expect(derived.origin).toBe("derived");

      const list = (await store.factsList({ scope })).data;
      const listedDefault = list.find((f) => f.id === defaulted.id);
      const listedDerived = list.find((f) => f.id === derived.id);
      expect(listedDefault?.origin).toBe("stated");
      expect(listedDerived?.origin).toBe("derived");

      const gotDefault = await store.factsGet(defaulted.id);
      const gotDerived = await store.factsGet(derived.id);
      expect(gotDefault?.origin).toBe("stated");
      expect(gotDerived?.origin).toBe("derived");

      await store.factsDelete(defaulted.id);
      await store.factsDelete(derived.id);
    });

    it("facts: an invalid origin value is rejected, not silently coerced", async () => {
      const scope = "test:origin-invalid";
      await expect(
        store.factsAdd({
          fact: "bad origin",
          scope,
          // deliberately outside the FactOrigin union — proves the DB-level
          // CHECK constraint holds even if a caller bypasses the TS type.
          origin: "guessed" as unknown as "stated",
        }),
      ).rejects.toThrow();
    });

    it("factsAdd: origin survives an upsert that omits it — a 'derived' fact re-added without origin does not silently become 'stated'", async () => {
      const scope = "test:origin-upsert-survives";
      const original = await store.factsAdd({
        fact: "derived fact via synthesis",
        scope,
        topicKey: "origin-upsert-key",
        origin: "derived",
      });
      expect(original.origin).toBe("derived");

      const upserted = await store.factsAdd({
        fact: "re-added without stating origin",
        scope,
        topicKey: "origin-upsert-key",
      });
      expect(upserted.id).toBe(original.id);
      expect(upserted.origin).toBe("derived");

      const refetched = await store.factsGet(original.id);
      expect(refetched?.origin).toBe("derived");

      await store.factsDelete(original.id);
    });

    it("brief reserve: facts lane truncates within its own budget, names the dropped tail, and the rendered text omits them", async () => {
      const scope = "test:brief-reserve-facts";
      const ids: number[] = [];
      // Each rendered line is well over 20 chars, so a tiny reserve (5 tok =
      // 20 chars) keeps only the first fact and drops the rest, in order.
      // Distinct descending importance forces a deterministic factsList order
      // (pinned desc, importance desc, updated_at desc) matching insertion
      // order, regardless of same-millisecond updated_at ties.
      for (let i = 0; i < 5; i++) {
        const f = await store.factsAdd({
          fact: `brief reserve fact number ${i} with enough text to blow a tiny budget`,
          scope,
          importance: 0.9 - i * 0.1,
        });
        ids.push(f.id);
      }

      const facts = (await store.factsList({ scope })).data;
      const cfg = kase.makeConfig();
      cfg.brief.reserve.facts = 5; // 20 chars — the first line alone exceeds it

      const brief = assembleBrief(
        {
          vision: { global: null, project: null },
          recentSessions: [],
          facts,
          relatedDocs: [],
          factsAvailable: facts.length,
          recentSessionsAvailable: 0,
        },
        { format: "markdown" },
        cfg,
      );

      expect(brief.meta.facts.truncated).toBe(true);
      // guard: the first item is never dropped, even though it alone busts the budget
      expect(brief.facts.length).toBeGreaterThanOrEqual(1);
      expect(brief.facts[0]!.id).toBe(facts[0]!.id);
      expect(brief.droppedItems.length).toBeGreaterThan(0);

      const keptIds = new Set(brief.facts.map((f) => f.id));
      const droppedFactIds = ids.filter((id) => !keptIds.has(id));
      expect(brief.droppedItems).toEqual(droppedFactIds.map((id) => `fact:${id}`));

      for (const id of droppedFactIds) {
        const dropped = facts.find((f) => f.id === id)!;
        expect(brief.text).not.toContain(dropped.fact);
      }

      // droppedItems name real, fetchable records — not placeholders.
      const resolved = await store.get(brief.droppedItems[0]!);
      expect(resolved).not.toBeNull();
      expect(resolved!.sourceType).toBe("fact");
      expect((resolved!.record as { id: number }).id).toBe(
        Number(brief.droppedItems[0]!.split(":")[1]),
      );

      for (const id of ids) await store.factsDelete(id);
    });

    it("brief reserve: vision lane truncates by chars, never appears in droppedItems", async () => {
      const longDetails = "vision prose ".repeat(200); // ~2600 chars
      await store.visionSet({ scope: "project:brief-reserve-vision", details: longDetails });
      const vision = await store.visionGet("project:brief-reserve-vision");
      expect(vision).not.toBeNull();

      const cfg = kase.makeConfig();
      cfg.brief.reserve.vision = 10; // 40 chars — far under the seeded prose

      const brief = assembleBrief(
        {
          vision: { global: null, project: vision },
          recentSessions: [],
          facts: [],
          relatedDocs: [],
          factsAvailable: 0,
          recentSessionsAvailable: 0,
        },
        { format: "markdown" },
        cfg,
      );

      expect(brief.meta.vision.truncated).toBe(true);
      // chars carry the truncation arithmetic; returned/available stay rows.
      expect(brief.meta.vision.chars!.available).toBeGreaterThan(brief.meta.vision.chars!.returned);
      expect(brief.meta.vision.returned).toBe(1);
      expect(brief.meta.vision.available).toBe(1);
      // no vision arm in SourceType/TypedId — it can never show up here.
      expect(brief.droppedItems.some((id) => id.startsWith("vision"))).toBe(false);

      const visionSectionStart = brief.text!.indexOf("=== VISION");
      const visionSectionEnd = brief.text!.indexOf("=== MOST RECENT WORK");
      const visionSection = brief.text!.slice(visionSectionStart, visionSectionEnd);
      // the section is bounded by the reserve, not by the full seeded prose
      expect(visionSection.length).toBeLessThan(longDetails.length);

      await store.visionDelete(vision!.id);
    });

    it("vision: summary falls back to truncated details when null; a set summary renders instead", async () => {
      await store.visionSet({
        scope: "project:vision-fallback-null",
        details: "full narrative details for the null-summary vision row",
      });
      await store.visionSet({
        scope: "project:vision-fallback-set",
        details: "full narrative details that should NOT appear when a summary is set",
        summary: "short injected summary",
      });

      const nullSummaryBrief = await store.brief({
        project: "vision-fallback-null",
        format: "markdown",
      });
      expect(nullSummaryBrief.text).toContain("full narrative details for the null-summary vision row");

      const setSummaryBrief = await store.brief({
        project: "vision-fallback-set",
        format: "markdown",
      });
      expect(setSummaryBrief.text).toContain("short injected summary");
      expect(setSummaryBrief.text).not.toContain(
        "full narrative details that should NOT appear when a summary is set",
      );

      const v1 = await store.visionGet("project:vision-fallback-null");
      const v2 = await store.visionGet("project:vision-fallback-set");
      await store.visionDelete(v1!.id);
      await store.visionDelete(v2!.id);
    });

    // -----------------------------------------------------------------
    // impact() — reverse lookup, lexical-only, crosses lane boundaries by
    // FLAGGING out-of-lane docs instead of DROPPING them (recall's behavior).
    // Every test here is written to fail against a fake that either (a)
    // quietly reuses recall's filter-then-drop semantics, or (b) falls back
    // to vector search, or (c) undercounts withheld hits in `meta.available`.
    // -----------------------------------------------------------------

    it("impact: lexical reverse lookup works with no embeddings (matchedBy === 'lexical')", async () => {
      const uniqueToken = "zzqimpactlexicaltoken";
      const f = await store.factsAdd({
        fact: `${uniqueToken} depends on this subject`,
        category: "impact-test",
      });

      const result = await store.impact(uniqueToken, { sources: ["fact"] });
      expect(result.data.length).toBeGreaterThan(0);
      for (const r of result.data) {
        expect(r.matchedBy).toBe("lexical");
        expect(r.citation).toBeTruthy();
      }

      await store.factsDelete(f.id);
    });

    it("impact: citation-only across a lane boundary — the out-of-lane doc is present, flagged, content withheld", async () => {
      const uniqueToken = "zzqimpactlaneboundarytoken";
      const globalDir = mkdtempSync(join(tmpdir(), "grounded-impact-global-test-"));
      const adminDir = mkdtempSync(join(tmpdir(), "grounded-impact-admin-test-"));
      writeFileSync(
        join(globalDir, "impact-global-doc.md"),
        `# Impact Global Doc\n\n${uniqueToken} engineering corpus prose that depends on the subject.\n`,
        "utf8",
      );
      writeFileSync(
        join(adminDir, "impact-admin-doc.md"),
        `# Impact Admin Doc\n\n${uniqueToken} administration business prose that also depends on it.\n`,
        "utf8",
      );

      await store.docsIngest([globalDir], { source: "impact-lane-test" });
      await store.docsIngest([adminDir], { source: "impact-lane-test", scope: "administration" });

      // default scopes → ['global']
      const result = await store.impact(uniqueToken, { sources: ["doc"], limit: 10 });

      const adminHit = result.data.find((r) => r.scope === "administration");
      expect(adminHit).toBeTruthy(); // NOT dropped — this is the whole point
      expect(adminHit!.inScope).toBe(false);
      expect(adminHit!.title).toBeNull();
      expect(adminHit!.snippet).toBeNull();
      expect(adminHit!.citation).toBeTruthy();
      expect(adminHit!.path).toBeTruthy();
      expect(adminHit!.scope).toBe("administration");

      // the in-scope global doc, same call: content intact
      const globalHit = result.data.find((r) => r.scope === "global");
      expect(globalHit).toBeTruthy();
      expect(globalHit!.inScope).toBe(true);
      expect(globalHit!.title).not.toBeNull();
      expect(globalHit!.snippet).not.toBeNull();
      expect(globalHit!.snippet).toContain(uniqueToken);

      // declaring the lane reveals the content
      const declared = await store.impact(uniqueToken, {
        sources: ["doc"],
        limit: 10,
        scopes: ["global", "administration"],
      });
      const revealed = declared.data.find((r) => r.scope === "administration");
      expect(revealed).toBeTruthy();
      expect(revealed!.inScope).toBe(true);
      expect(revealed!.title).not.toBeNull();
      expect(revealed!.snippet).not.toBeNull();
      expect(revealed!.snippet).toContain(uniqueToken);

      // recall() is UNCHANGED: the administration doc must not appear at all,
      // not even withheld — this guarantees the filter-then-flag change did
      // not leak into recall's filter-then-drop path.
      const recalled = await store.recall(uniqueToken, { sources: ["doc"], limit: 10 });
      expect(recalled.data.some((r) => r.path === adminHit!.path)).toBe(false);
      expect(recalled.data.every((r) => r.scope !== "administration")).toBe(true);
      // recall's own available accounting must not count the doc it dropped
      expect(recalled.meta.bySource?.doc?.available).toBe(1);

      rmSync(globalDir, { recursive: true, force: true });
      rmSync(adminDir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("impact: meta.available counts a withheld hit even when it is the ONLY match (a found-but-hidden doc is not an absent one)", async () => {
      const uniqueToken = "zzqimpactwithheldonlytoken";
      const dir = mkdtempSync(join(tmpdir(), "grounded-impact-withheld-only-test-"));
      writeFileSync(
        join(dir, "impact-withheld-only-doc.md"),
        `# Impact Withheld Only Doc\n\n${uniqueToken} lives only in the administration lane.\n`,
        "utf8",
      );
      await store.docsIngest([dir], { source: "impact-withheld-only-test", scope: "administration" });

      const result = await store.impact(uniqueToken, { sources: ["doc"], limit: 10 });
      expect(result.data.length).toBe(1);
      expect(result.data[0]!.inScope).toBe(false);
      expect(result.data[0]!.title).toBeNull();
      // the doc was found — a fake that computes available from in-scope
      // hits only would report 0 here.
      expect(result.meta.available).toBe(1);
      expect(result.meta.bySource?.doc?.available).toBe(1);
      expect(result.meta.returned).toBe(1);

      rmSync(dir, { recursive: true, force: true });
      await store.docsPrune({ remove: true });
    });

    it("impact: facts and sessions are never laned — always inScope:true, scope:'global', regardless of declared doc scopes", async () => {
      const uniqueToken = "zzqimpactunlanedtoken";
      const f = await store.factsAdd({
        fact: `${uniqueToken} fact that some other thing depends on`,
        category: "impact-test",
      });
      const s = await store.sessionsAdd({
        summary: `${uniqueToken} session that some other thing depends on`,
      });

      // declare a doc scope that isn't "global" at all — facts/sessions must
      // be unaffected, because `scopes` means the DOC lane, not a general filter.
      const result = await store.impact(uniqueToken, {
        sources: ["fact", "session"],
        scopes: ["some-unrelated-lane"],
      });

      const factHit = result.data.find((r) => r.sourceType === "fact" && r.id === f.id);
      const sessionHit = result.data.find((r) => r.sourceType === "session" && r.id === s.id);
      expect(factHit).toBeTruthy();
      expect(sessionHit).toBeTruthy();
      expect(factHit!.inScope).toBe(true);
      expect(factHit!.scope).toBe("global");
      expect(sessionHit!.inScope).toBe(true);
      expect(sessionHit!.scope).toBe("global");

      await store.factsDelete(f.id);
    });

    it("impact: limit and truncated accounting — available reflects the true match count, returned is capped, truncated is honest", async () => {
      const uniqueToken = "zzqimpactlimittoken";
      const scope = "test:impact-limit";
      const seedCount = 12;
      const limit = 4;
      const ids: number[] = [];
      for (let i = 0; i < seedCount; i++) {
        const f = await store.factsAdd({
          fact: `${uniqueToken} candidate ${i}`,
          scope,
          importance: 0.5,
        });
        ids.push(f.id);
      }

      const result = await store.impact(uniqueToken, { sources: ["fact"], limit });
      expect(result.data.length).toBeLessThanOrEqual(limit);
      expect(result.meta.returned).toBeLessThanOrEqual(limit);
      expect(result.meta.available).toBe(seedCount);
      expect(result.meta.truncated).toBe(true);

      for (const id of ids) await store.factsDelete(id);
    });

    it("impact: limit overrides recall's sourceCaps — a dependency pre-flight is not a top-10 reading list", async () => {
      // recall.sourceCaps defaults to 10 per source. A caller asking what
      // depends on a subject must be able to see all of it; capping a
      // pre-flight at an unrelated ranking constant is the wrong answer even
      // with truncated:true saying so.
      const uniqueToken = "zzqimpactcapoverridetoken";
      const scope = "test:impact-cap";
      const seedCount = 14; // > the default sourceCap of 10
      const ids: number[] = [];
      for (let i = 0; i < seedCount; i++) {
        const f = await store.factsAdd({ fact: `${uniqueToken} dependent ${i}`, scope });
        ids.push(f.id);
      }

      const result = await store.impact(uniqueToken, { sources: ["fact"], limit: seedCount });
      expect(result.meta.available).toBe(seedCount);
      expect(result.data.length).toBe(seedCount); // NOT clamped to 10
      expect(result.meta.returned).toBe(seedCount);
      expect(result.meta.truncated).toBe(false);

      for (const id of ids) await store.factsDelete(id);
    });

    it("impact: no-match subject returns empty data without throwing; a punctuation-only subject exercises the FTS sanitiser", async () => {
      const noMatch = await store.impact("zzqimpactnosuchsubjectatall999");
      expect(noMatch.data).toEqual([]);
      expect(noMatch.meta.returned).toBe(0);
      expect(noMatch.meta.available).toBe(0);
      expect(noMatch.meta.truncated).toBe(false);

      // punctuation-only subject must not throw (sqlite FTS5 query sanitiser)
      await expect(store.impact("---")).resolves.not.toThrow();
      const punctuationOnly = await store.impact("---");
      expect(Array.isArray(punctuationOnly.data)).toBe(true);
    });
  });
}
