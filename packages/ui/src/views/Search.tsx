import { useEffect, useState } from "preact/hooks";
import type { RecallResult, SourceType, MatchedBy, DeliveryMeta } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useApp } from "../app.js";
import { copyText, typeLabel } from "../util.js";
import { toast } from "../hooks.js";

const ALL_SOURCES: SourceType[] = ["fact", "session", "doc"];
const MATCH_COLOR: Record<MatchedBy, string> = {
  vector: "var(--sage-deep)",
  lexical: "var(--copper)",
  both: "var(--sage)",
};

interface RunInfo {
  meta: DeliveryMeta;
  ms: number;
}

/** Search — one query over everything the cabinet remembers. The project
 * scope comes from the shell's project switcher; there are no other knobs. */
export function SearchView() {
  const { openRecord, params, navigate, project } = useApp();
  const seed = params.get("q") ?? "";
  const [query, setQuery] = useState(seed);
  const [source, setSource] = useState<SourceType | "all">("all");
  const [results, setResults] = useState<RecallResult[] | null>(null);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (q: string, src: SourceType | "all" = source) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const res = await api.recall(q.trim(), {
        // `limit` is a TOTAL across sources; ask for a page-sized answer.
        limit: 30,
        sources: src === "all" ? undefined : [src],
        project: project ?? undefined,
      });
      setResults(res.data);
      setRunInfo({ meta: res.meta, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      setError(errMessage(e));
      setResults([]);
      setRunInfo(null);
    } finally {
      setBusy(false);
    }
  };

  // Arriving with #/search?q=… (topbar, tray, deep link) runs it.
  useEffect(() => {
    if (seed) {
      setQuery(seed);
      run(seed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const submit = (e: Event) => {
    e.preventDefault();
    navigate("search", { q: query.trim() });
    run(query);
  };

  const pick = (s: SourceType | "all") => {
    setSource(s);
    if (query.trim()) run(query, s);
  };

  return (
    <div class="view-max">
      <h1 class="h-serif display">Search</h1>
      <p class="lede">Find anything your agents know — by meaning, not just by words.</p>

      <form onSubmit={submit} class="search-bar">
        <span class="mono" aria-hidden="true" style={{ color: "var(--ink-faint)" }}>⌕</span>
        <input
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="where does the windows cabinet live?"
          aria-label="Search query"
        />
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? <span class="spinner" /> : "Search"}
        </button>
      </form>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.4rem" }}>
        <button class={`chip${source === "all" ? " active" : ""}`} onClick={() => pick("all")}>All</button>
        <button class={`chip${source === "fact" ? " active" : ""}`} onClick={() => pick("fact")}>Facts</button>
        <button class={`chip${source === "session" ? " active" : ""}`} onClick={() => pick("session")}>Sessions</button>
        <button class={`chip${source === "doc" ? " active" : ""}`} onClick={() => pick("doc")}>Docs</button>
      </div>

      {error && <div class="empty" style={{ color: "var(--danger)" }}>{error}</div>}
      {runInfo && (
        <div class="mono" style={{ fontSize: "0.72rem", color: "var(--ink-faint)", marginBottom: "1rem" }}>
          {runInfo.meta.returned} of {runInfo.meta.available} matched · {runInfo.ms} ms
          {project ? ` · ${project}` : ""}
        </div>
      )}

      {results && results.length === 0 && !error && <div class="empty">No matches. Try a broader query.</div>}
      {results === null && !busy && (
        <div class="empty">Search facts, sessions, and docs in one go.</div>
      )}

      {results && ALL_SOURCES.map((st) => {
        const lane = results.filter((r) => r.sourceType === st);
        if (lane.length === 0) return null;
        return (
          <section key={st} style={{ marginBottom: "1.6rem" }}>
            <div class="field-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
              <span class={`type-tag ${st}`}>{typeLabel(st)}</span>
              <span style={{ color: "var(--ink-faint)" }}>· {lane.length}</span>
            </div>
            {lane.map((r) => (
              <div key={r.typedId} class="row" style={{ display: "block" }} onClick={() => openRecord(r.typedId)}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.35rem" }}>
                  <span class="row-title" style={{ fontWeight: 500 }}>{r.title}</span>
                  <span class="row-meta" style={{ color: MATCH_COLOR[r.matchedBy], marginLeft: "auto" }}>{r.matchedBy}</span>
                  <span class="row-meta">{r.score.toFixed(3)}</span>
                </div>
                {r.snippet && (
                  <div style={{ color: "var(--ink-soft)", fontSize: "0.84rem", lineHeight: 1.5 }}>{r.snippet}</div>
                )}
                <div style={{ display: "flex", alignItems: "center", marginTop: "0.35rem" }}>
                  <span class="mono" style={{ fontSize: "0.62rem", color: "var(--ink-faint)" }}>{r.citation}</span>
                  <button
                    class="btn btn-ghost btn-sm"
                    style={{ marginLeft: "auto", minHeight: 0, padding: "0.15rem 0.5rem", fontSize: "0.68rem" }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      toast((await copyText(r.typedId)) ? `${r.typedId} copied` : "Copy failed");
                    }}
                  >
                    Copy id
                  </button>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
