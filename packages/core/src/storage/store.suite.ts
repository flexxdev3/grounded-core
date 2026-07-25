import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStore } from "../store.js";
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

      const activeList = await store.factsList({ status: "active" });
      expect(activeList.some((x) => x.id === f.id)).toBe(false);

      const archivedList = await store.factsList({ status: "archived" });
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

      const results = await store.recall(uniqueToken, { sources: ["fact"], limit: 10 });
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

      const docs = await store.docsList();
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

      const docs = await store.docsList({ source: "default-scope-test" });
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
      const scoped = await store.recall("zzqadminlanetoken", {
        sources: ["doc"],
        scopes: ["administration"],
        limit: 10,
      });
      expect(scoped.some((r) => r.snippet.includes("zzqadminlanetoken"))).toBe(true);

      const unscoped = await store.recall("zzqadminlanetoken", { sources: ["doc"], limit: 10 });
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

      const adminOnly = await store.recall("zzqscopematrixtoken", {
        sources: ["doc"],
        scopes: ["administration"],
        limit: 10,
      });
      expect(adminOnly.some((r) => r.snippet.includes("zzqscopematrixtoken"))).toBe(true);

      const both = await store.recall("zzqscopematrixtoken", {
        sources: ["doc"],
        scopes: ["global", "administration"],
        limit: 10,
      });
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

      const before = await store.docsList({ source: "retag-test" });
      const hashBefore = new Map(before.map((d) => [d.id, d.bodyHash]));

      const second = await store.docsIngest([dir], {
        source: "retag-test",
        scope: "administration",
      });
      expect(second.retagged).toBeGreaterThan(0);
      expect(second.updated).toBe(0);
      expect(second.added).toBe(0);

      const after = await store.docsList({ source: "retag-test" });
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
      const before = await store.docsList({ source: "retag-dryrun-test" });
      const scopeBefore = before.map((d) => d.scope);
      expect(scopeBefore.every((s) => s === "global")).toBe(true);

      const dry = await store.docsIngest([dir], {
        source: "retag-dryrun-test",
        scope: "administration",
        dryRun: true,
      });
      expect(dry.retagged).toBeGreaterThan(0);

      const after = await store.docsList({ source: "retag-dryrun-test" });
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

      const bySource = await store.docsList({ source: "list-source-a" });
      expect(bySource.length).toBeGreaterThan(0);
      expect(bySource.every((d) => d.source === "list-source-a")).toBe(true);

      const byScope = await store.docsList({ scope: "administration" });
      expect(byScope.length).toBeGreaterThan(0);
      expect(byScope.every((d) => d.scope === "administration")).toBe(true);
      expect(byScope.some((d) => d.source === "list-source-b")).toBe(true);

      const unfiltered = await store.docsList();
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

    it("docsPrune with remove:true deletes rows for a file removed from disk", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grounded-prune-remove-test-"));
      writeFileSync(
        join(dir, "prune-remove-doc.md"),
        "# Prune Remove Doc\n\nzzqpruneremovetoken content to be deleted from disk.\n",
        "utf8",
      );

      const report = await store.docsIngest([dir], { source: "prune-remove-test" });
      expect(report.added).toBeGreaterThan(0);

      const before = await store.docsList({ source: "prune-remove-test" });
      expect(before.length).toBeGreaterThan(0);

      // delete the file itself, not the tmp dir, so the path the row stores
      // is unambiguously gone but the parent dir still exists for cleanup.
      rmSync(join(dir, "prune-remove-doc.md"));

      const pruned = await store.docsPrune({ remove: true });
      expect(pruned.removed).toBeGreaterThanOrEqual(before.length);

      const after = await store.docsList({ source: "prune-remove-test" });
      expect(after.length).toBe(0);

      rmSync(dir, { recursive: true, force: true });
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
}
