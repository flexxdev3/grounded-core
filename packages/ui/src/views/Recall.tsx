import { useState, useEffect } from "preact/hooks";
import type { RecallResult, SourceType, MatchedBy, DeliveryMeta } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useApp } from "../app.js";
import { typeLabel } from "../util.js";

const ALL_SOURCES: SourceType[] = ["fact", "session", "doc"];
const MATCH_COLOR: Record<MatchedBy, string> = {
  vector: "var(--verdigris)",
  lexical: "var(--copper)",
  both: "var(--verdigris-bright)",
};

interface RunInfo {
  meta: DeliveryMeta;
  mode: string;
  project?: string;
  ms: number;
}

export function RecallView() {
  const { openRecord, recallSeed, project } = useApp();
  const [query, setQuery] = useState(recallSeed);
  const [sources, setSources] = useState<Set<SourceType>>(new Set(ALL_SOURCES));
  const [lexicalOnly, setLexicalOnly] = useState(false);
  const [scoped, setScoped] = useState(true);
  const [results, setResults] = useState<RecallResult[] | null>(null);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      const src = [...sources];
      const proj = scoped && project ? project : undefined;
      const res = await api.recall(q.trim(), {
        sources: src.length === ALL_SOURCES.length ? undefined : src,
        lexicalOnly,
        project: proj,
      });
      const ms = Math.round(performance.now() - t0);
      setResults(res.data);
      setRunInfo({ meta: res.meta, mode: lexicalOnly ? "lexical" : "hybrid", project: proj, ms });
    } catch (e) {
      setError(errMessage(e));
      setResults([]);
      setRunInfo(null);
    } finally {
      setBusy(false);
    }
  };

  // auto-run when arriving from the topbar search (recallSeed changes)
  useEffect(() => {
    if (recallSeed) {
      setQuery(recallSeed);
      run(recallSeed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recallSeed]);

  const toggleSource = (s: SourceType) => {
    const next = new Set(sources);
    if (next.has(s) && next.size > 1) next.delete(s);
    else next.add(s);
    setSources(next);
  };

  return (
    <div class="view-max">
      <div class="eyebrow">&gt;_ recall · hybrid search · rank fusion</div>
      <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: "0 0 1.2rem" }}>Recall</h1>

      <form onSubmit={(e) => { e.preventDefault(); run(query); }}
        style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.7rem 1rem", borderRadius: "11px", border: "1px solid var(--line-copper)", background: "rgba(6,9,8,0.6)", marginBottom: "1rem" }}>
        <span class="mono" style={{ color: "var(--copper)" }}>&gt;_</span>
        <input value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="what did we decide about sqlite?"
          style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", color: "#f1ece0", fontSize: "1rem", fontFamily: "var(--mono)" }} />
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
          {busy ? <span class="spinner" /> : "Recall"}
        </button>
      </form>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.4rem", alignItems: "center" }}>
        {ALL_SOURCES.map((s) => (
          <button key={s} class={`chip${sources.has(s) ? " active" : ""}`} onClick={() => toggleSource(s)}>
            {typeLabel(s)}
          </button>
        ))}
        {project && (
          <button class={`chip${scoped ? " active" : ""}`} onClick={() => setScoped(!scoped)}
            style={{ marginLeft: "auto" }} title="Bias facts & sessions toward the current project">
            {scoped ? `scoped · ${project}` : "all projects"}
          </button>
        )}
        <button class={`chip${lexicalOnly ? " active" : ""}`} onClick={() => setLexicalOnly(!lexicalOnly)}
          style={project ? undefined : { marginLeft: "auto" }}>
          lexical-only
        </button>
      </div>

      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}
      {runInfo && (
        <div class="mono" style={{ fontSize: "0.72rem", color: "rgba(190,214,178,0.7)", marginBottom: "1rem" }}>
          <div>
            <span style={{ color: "var(--verdigris)" }}>→</span>{" "}
            {runInfo.meta.returned} of {runInfo.meta.available} matched · {runInfo.mode}
            {runInfo.project ? ` · ${runInfo.project}` : ""} · {runInfo.ms}ms
            {runInfo.meta.truncated && (
              <span class="mono" style={{ color: "var(--copper-bright)", marginLeft: "0.5rem" }}>truncated</span>
            )}
          </div>
          {runInfo.meta.bySource && (
            <div style={{ marginTop: "0.25rem", paddingLeft: "1.1rem", color: "rgba(236,230,216,0.4)" }}>
              {ALL_SOURCES.filter((s) => runInfo.meta.bySource?.[s]).map((s, i) => {
                const b = runInfo.meta.bySource![s]!;
                return (
                  <span key={s}>
                    {i > 0 && " · "}
                    {typeLabel(s)} {b.returned}/{b.available}
                    {b.truncated ? "*" : ""}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {results && results.length === 0 && !error && (
        <div class="empty">No matches. Try a broader query.</div>
      )}
      {results === null && !busy && (
        <div class="empty">Run a query to search facts, sessions, and docs.</div>
      )}

      {results && ALL_SOURCES.map((st) => {
        const lane = results.filter((r) => r.sourceType === st);
        if (lane.length === 0) return null;
        return (
          <section key={st} style={{ marginBottom: "1.6rem" }}>
            <div class="field-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
              <span class={`type-tag ${st}`}>{typeLabel(st)}</span>
              <span style={{ color: "rgba(236,230,216,0.35)" }}>· {lane.length}</span>
            </div>
            {lane.map((r) => (
              <div key={r.typedId} class="row" style={{ display: "block" }} onClick={() => openRecord(r.typedId)}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.35rem" }}>
                  <span class="row-title" style={{ fontWeight: 500 }}>{r.title}</span>
                  <span class="row-meta" style={{ color: MATCH_COLOR[r.matchedBy], marginLeft: "auto" }}>{r.matchedBy}</span>
                  <span class="row-meta">{r.score.toFixed(3)}</span>
                </div>
                {r.snippet && (
                  <div style={{ color: "rgba(236,230,216,0.6)", fontSize: "0.84rem", lineHeight: 1.5 }}>{r.snippet}</div>
                )}
                <div class="mono" style={{ fontSize: "0.62rem", color: "rgba(236,230,216,0.35)", marginTop: "0.35rem" }}>{r.citation}</div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
