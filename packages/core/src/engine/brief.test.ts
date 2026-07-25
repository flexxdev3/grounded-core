import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import type { GroundedConfig, Session, Store, TypedId } from "../contract.js";
import { openStore } from "../store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

// POST /brief must not drop bodies — fact.detail and the related-doc snippet
// survive into the rendered markdown alongside their citations.
//
// Sessions are the deliberate exception: the brief renders `summary` only and
// leaves `details` behind `ground_get`. A session log is unbounded (8 of them
// cost ~7k tok, several times the whole startup budget), so inlining it in a
// budgeted lane would starve every other lane. fact.detail is a single short
// trigger and stays inline — short field inline, long field behind an id.
describe("brief: renders bodies, not just headings", () => {
  let home: string;
  let store: Store;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "grounded-brief-test-"));
    const cfg: GroundedConfig = defaultConfig(home);
    cfg.storage.adapter = "sqlite";
    cfg.storage.path = join(home, "grounded.db");
    cfg.embeddings.provider = "none";
    cfg.embeddings.dims = 0;
    store = await openStore(cfg);
  });

  afterAll(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("markdown includes fact detail and a doc snippet; session details stay behind ground_get", async () => {
    await store.factsAdd({
      fact: "never push to any remote without explicit instruction",
      detail: "gh is authed to a public account, double-check before pushing",
      category: "commit-rule",
      importance: 1,
    });

    await store.sessionsAdd({
      summary: "wired up the brief renderer",
      details: "added whitespace-collapsed bodies for facts, sessions, and related docs",
      project: "grounded",
    });

    await store.docsIngest([EXAMPLES], { source: "examples" });
    const docs = (await store.docsList()).data;
    const seedDoc = docs[0]!;

    const brief = await store.brief({
      format: "markdown",
      project: "grounded",
      query: seedDoc.title ?? seedDoc.body.slice(0, 40),
    });

    expect(brief.text).toBeTruthy();
    const text = brief.text!;

    expect(text).toContain("gh is authed to a public account, double-check before pushing");
    expect(text).toMatch(/\(fact:\d+\)/);

    // The session's summary and citation are present...
    expect(text).toContain("wired up the brief renderer");
    expect(text).toMatch(/\(session:\d+\)/);
    // ...but its details are NOT inlined into the budgeted lane.
    expect(text).not.toContain(
      "added whitespace-collapsed bodies for facts, sessions, and related docs",
    );
    // They must still be one hop away, or this is data loss rather than
    // progressive disclosure. Resolve the cited id and assert the body is there.
    const citedId = /\((session:\d+)\)/.exec(text)?.[1] as TypedId;
    const full = await store.get(citedId);
    expect(full?.sourceType).toBe("session");
    expect((full?.record as Session).details).toContain(
      "added whitespace-collapsed bodies for facts, sessions, and related docs",
    );

    expect(brief.relatedDocs.length).toBeGreaterThan(0);
    const doc = brief.relatedDocs[0]!;
    expect(doc.snippet.trim().length).toBeGreaterThan(0);
    const collapsedSnippet = doc.snippet.replace(/\s+/g, " ").trim();
    expect(text).toContain(collapsedSnippet);
    expect(text).toContain(doc.citation);
  });
});
