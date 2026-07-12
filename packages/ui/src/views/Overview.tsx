import { useEffect } from "preact/hooks";
import type { HealthReport, Fact } from "@grounded/core/contract";
import { api } from "../api.js";
import { useAsync, useDataVersion } from "../hooks.js";
import { useApp } from "../app.js";

export function OverviewView({ onAdapter }: { onAdapter: (a: string) => void }) {
  const { navigate, setCounts, project } = useApp();
  const version = useDataVersion();
  const health = useAsync<HealthReport>(() => api.health(), [version]);
  const facts = useAsync<Fact[]>(() => api.facts.list({ limit: 200 }), [version]);

  const h = health.data;
  useEffect(() => {
    if (h) {
      setCounts({ facts: h.counts.facts, sessions: h.counts.sessions, documents: h.counts.documents });
      onAdapter(h.storage.adapter);
    }
  }, [h]);
  const pinned = (facts.data ?? []).filter((f) => f.pinned).length;

  const cards: { key: string; num: string | number; label: string; sub: string; view: Parameters<typeof navigate>[0] }[] = [
    { key: "facts", num: h?.counts.facts ?? "—", label: "Facts", sub: `${pinned} pinned`, view: "facts" },
    { key: "sessions", num: h?.counts.sessions ?? "—", label: "Sessions", sub: "logged work", view: "sessions" },
    { key: "docs", num: h?.counts.documents ?? "—", label: "Docs", sub: h ? `${h.counts.docs} chunks` : "indexed", view: "docs" },
  ];

  return (
    <div class="view-max">
      <div class="eyebrow">&gt;_ overview · the cabinet at a glance</div>
      <h1 class="h-serif" style={{ fontSize: "2.1rem", margin: "0 0 0.4rem" }}>Everything the agents recall.</h1>
      <p style={{ margin: "0 0 1.8rem", color: "var(--paper-soft)", fontSize: "1rem", maxWidth: "48ch", lineHeight: 1.55 }}>
        Pinned truth ranks first; sessions and docs keep it honest. Recall fuses all three.
      </p>

      <div class="stat-grid">
        {cards.map((c) => (
          <button key={c.key} class="card stat-btn" onClick={() => navigate(c.view)}>
            <div class="stat-num">{c.num}</div>
            <div class="stat-label">{c.label}</div>
            <div class="stat-sub">{c.sub}</div>
          </button>
        ))}
        <button class="card stat-btn stat-copper" onClick={() => navigate("sessions")}>
          <div class="stat-num h-serif" style={{ fontSize: project ? "1.7rem" : "2rem", lineHeight: 1.1, wordBreak: "break-word" }}>
            {project ?? "All"}
          </div>
          <div class="stat-label">Focus</div>
          <div class="stat-sub">{project ? "current project →" : "all projects →"}</div>
        </button>
      </div>

      <div class="card" style={{ marginTop: "1.4rem", display: "flex", flexDirection: "column" }}>
        <span class="mono" style={{ fontSize: "0.66rem", letterSpacing: "0.13em", textTransform: "uppercase", color: "rgba(190,214,178,0.8)", marginBottom: "0.7rem" }}>
          Brief — agent-ready
        </span>
        <p style={{ margin: "0 0 1rem", color: "var(--paper-soft)", fontSize: "0.9rem", lineHeight: 1.5 }}>
          Assemble the startup context any agent should load first — recent sessions, pinned facts, related docs.
        </p>
        <div class="terminal" style={{ whiteSpace: "nowrap" }}>
          <span class="accent">&gt;_</span> <span class="kw">ground brief</span> --agent claude{project ? ` --project ${project}` : ""}
          <span style={{ display: "inline-block", width: "0.5em", height: "1em", background: "var(--verdigris)", boxShadow: "0 0 12px rgba(156,191,145,0.6)", transform: "translateY(0.16em)", marginLeft: "0.1em", animation: "blink 1.1s steps(1) infinite" }} />
        </div>
        <button class="btn btn-sm" style={{ marginTop: "1rem", alignSelf: "flex-start" }} onClick={() => navigate("brief")}>
          Open brief →
        </button>
      </div>

      {(health.error || facts.error) && (
        <div class="empty" style={{ color: "var(--copper-bright)", marginTop: "1.4rem" }}>
          {health.error ?? facts.error}
        </div>
      )}
    </div>
  );
}
