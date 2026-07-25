import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import type { GroundedConfig, Store } from "../contract.js";
import { openStore } from "../store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES = resolve(__dirname, "../../../../examples/docs");

// POST /brief renders headings but must not drop bodies — fact.detail, session.details,
// and the related-doc snippet all need to survive into the rendered markdown text
// alongside their citations.
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

  it("markdown text includes fact detail, session details, and a related-doc snippet", async () => {
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
    const docs = await store.docsList();
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

    expect(text).toContain(
      "added whitespace-collapsed bodies for facts, sessions, and related docs",
    );
    expect(text).toMatch(/\(session:\d+\)/);

    expect(brief.relatedDocs.length).toBeGreaterThan(0);
    const doc = brief.relatedDocs[0]!;
    expect(doc.snippet.trim().length).toBeGreaterThan(0);
    const collapsedSnippet = doc.snippet.replace(/\s+/g, " ").trim();
    expect(text).toContain(collapsedSnippet);
    expect(text).toContain(doc.citation);
  });
});
