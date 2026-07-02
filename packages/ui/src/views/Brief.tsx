import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { BriefResult } from "@grounded/core/contract";
import { api } from "../api.js";
import { useAsync, toast, useDataVersion } from "../hooks.js";
import { useApp } from "../app.js";
import { copyText, fmtDate } from "../util.js";

export function BriefView() {
  const { openRecord } = useApp();
  const version = useDataVersion();
  const [agent, setAgent] = useState("claude");
  const [project, setProject] = useState("");
  const [pending, setPending] = useState({ agent: "claude", project: "" });
  const { data, loading, error } = useAsync<BriefResult>(
    () => api.brief({ agent: pending.agent || undefined, project: pending.project || undefined, format: "markdown" }),
    [pending, version],
  );

  const run = (e: Event) => {
    e.preventDefault();
    setPending({ agent: agent.trim(), project: project.trim() });
  };

  const copy = async () => {
    if (data?.text) toast((await copyText(data.text)) ? "Brief copied" : "Copy failed");
  };

  return (
    <div class="view-max">
      <div class="eyebrow">&gt;_ brief · the working set</div>
      <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: "0 0 1.2rem" }}>Startup brief</h1>

      <form onSubmit={run} style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginBottom: "1.4rem" }}>
        <input class="input" style={{ flex: "1 1 8rem" }} value={agent} placeholder="agent (claude)"
          onInput={(e) => setAgent((e.target as HTMLInputElement).value)} />
        <input class="input" style={{ flex: "1 1 8rem" }} value={project} placeholder="project (optional)"
          onInput={(e) => setProject((e.target as HTMLInputElement).value)} />
        <button type="submit" class="btn btn-primary btn-sm">Assemble</button>
      </form>

      <div class="terminal" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1.4rem", whiteSpace: "nowrap" }}>
        <span class="accent">&gt;_</span> <span class="kw">ground brief</span> --agent {pending.agent || "agent"}{pending.project ? ` --project ${pending.project}` : ""}
        <button class="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={copy} disabled={!data?.text}>Copy</button>
      </div>

      {loading && <div class="empty">Assembling…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}

      {data && (
        <div class="stack" style={{ gap: "1.4rem" }}>
          <Section title={`Facts · ${data.facts.length}`}>
            {data.facts.length === 0 && <Muted>No facts in scope.</Muted>}
            {data.facts.map((f) => (
              <div key={f.id} class="row" onClick={() => openRecord(`fact:${f.id}`)}>
                {f.pinned && <span class="pin-dot">★</span>}
                <span class="row-title">{f.fact}</span>
                <span class="row-meta">{f.scope}</span>
              </div>
            ))}
          </Section>

          <Section title={`Recent sessions · ${data.recentSessions.length}`}>
            {data.recentSessions.length === 0 && <Muted>No recent sessions.</Muted>}
            {data.recentSessions.map((s) => (
              <div key={s.id} class="row" onClick={() => openRecord(`session:${s.id}`)}>
                <span class="row-title">{s.summary}</span>
                <span class="row-meta">{fmtDate(s.createdAt).slice(0, 10)}</span>
              </div>
            ))}
          </Section>

          <Section title={`Related docs · ${data.relatedDocs.length}`}>
            {data.relatedDocs.length === 0 && <Muted>No related docs.</Muted>}
            {data.relatedDocs.map((d) => (
              <div key={d.typedId} class="row" onClick={() => openRecord(d.typedId)}>
                <span class="type-tag doc">doc</span>
                <span class="row-title">{d.title}</span>
                <span class="row-meta">{d.citation}</span>
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div>
      <div class="field-label" style={{ marginBottom: "0.7rem" }}>{title}</div>
      {children}
    </div>
  );
}
function Muted({ children }: { children: ComponentChildren }) {
  return <div class="mono" style={{ fontSize: "0.75rem", color: "rgba(236,230,216,0.4)" }}>{children}</div>;
}
