import { useState, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { BriefResult, DeliveryMeta } from "@grounded/core/contract";
import { api } from "../api.js";
import { useAsync, toast, useDataVersion } from "../hooks.js";
import { useApp } from "../app.js";
import { copyText, fmtDate } from "../util.js";

/** Brief — the exact startup context an agent receives here, plus how full
 * each lane's budget ran. */
export function BriefView() {
  const { openRecord, project: ctxProject, projects, health } = useApp();
  const version = useDataVersion();
  const [agent, setAgent] = useState("claude");
  const [project, setProject] = useState(ctxProject ?? "");
  const [pending, setPending] = useState({ agent: "claude", project: ctxProject ?? "" });

  // Follow the global project switcher until the user overrides it here.
  useEffect(() => {
    setProject(ctxProject ?? "");
    setPending((p) => ({ ...p, project: ctxProject ?? "" }));
  }, [ctxProject]);

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

  const projectOptions = project && !projects.includes(project) ? [project, ...projects] : projects;

  return (
    <div class="view-max">
      <h1 class="h-serif display">What your agent sees</h1>
      <p class="lede">The exact brief an agent gets when a session starts here.</p>

      <form onSubmit={run} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "0.6rem", alignItems: "end", marginBottom: "1.4rem" }}>
        <div>
          <label class="field-label">Project</label>
          <select class="select" value={project} onChange={(e) => setProject((e.target as HTMLSelectElement).value)}>
            <option value="">— none —</option>
            {projectOptions.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="field-label">Agent</label>
          <input class="input" value={agent} placeholder="claude"
            onInput={(e) => setAgent((e.target as HTMLInputElement).value)} />
        </div>
        <button type="submit" class="btn btn-primary">Assemble</button>
      </form>

      {loading && <div class="empty">Assembling…</div>}
      {error && <div class="empty" style={{ color: "var(--danger)" }}>{error}</div>}

      {data && (
        <div class="stack" style={{ gap: "1.4rem" }}>
          <section class="card" aria-label="Budget by lane" style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
            <div class="field-label" style={{ margin: 0 }}>Budget by lane</div>
            <Lane label="Vision" meta={data.meta.vision} unit="chars"
              cap={(health?.budget?.vision?.reserveTok ?? 0) * 4 || undefined} />
            <Lane label="Facts" meta={data.meta.facts} unit="rows" />
            <Lane label="Sessions" meta={data.meta.sessions} unit="rows" />
            {(data.droppedItems.length > 0 || data.indexedItems.length > 0) && (
              <div class="queue-sub" style={{ lineHeight: 1.6 }}>
                {data.droppedItems.length > 0 && (
                  <>
                    Did not fit:{" "}
                    {data.droppedItems.slice(0, 8).map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <button class="link-btn mono" onClick={() => openRecord(id)}>{id}</button>
                      </span>
                    ))}
                    {data.droppedItems.length > 8 && ` and ${data.droppedItems.length - 8} more`}
                    .{" "}
                  </>
                )}
                {data.indexedItems.length > 0 && (
                  <>
                    Compressed to one line:{" "}
                    {data.indexedItems.slice(0, 8).map((id, i) => (
                      <span key={id}>
                        {i > 0 && ", "}
                        <button class="link-btn mono" onClick={() => openRecord(id)}>{id}</button>
                      </span>
                    ))}
                    {data.indexedItems.length > 8 && ` and ${data.indexedItems.length - 8} more`}
                    .
                  </>
                )}
              </div>
            )}
          </section>

          {data.text && (
            <section aria-label="Startup payload" class="term-wrap">
              <div class="term-head">
                <span class="mono">startup payload · {new Blob([data.text]).size.toLocaleString()} bytes</span>
                <button class="btn btn-ghost btn-sm term-copy" onClick={copy}>Copy</button>
              </div>
              <pre class="term-block">{data.text}</pre>
            </section>
          )}

          <Section title={`Most recent work · ${data.recentSessions.length}`}>
            {data.recentSessions.length === 0 && <Muted>No recent sessions.</Muted>}
            {data.recentSessions.map((s) => (
              <div key={s.id} class="row" onClick={() => openRecord(`session:${s.id}`)}>
                <span class="row-title">{s.summary}</span>
                <span class="row-meta">{[s.project, fmtDate(s.createdAt).slice(0, 10)].filter(Boolean).join(" · ")}</span>
              </div>
            ))}
          </Section>

          <Section title={`Facts in scope · ${data.facts.length}`}>
            {data.facts.length === 0 && <Muted>No facts in scope.</Muted>}
            {data.facts.map((f) => (
              <div key={f.id} class="row" onClick={() => openRecord(`fact:${f.id}`)}>
                {f.pinned && <span class="pin-dot">★</span>}
                <span class="row-title">{f.fact}</span>
                <span class="row-meta">{f.scope}</span>
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

function Lane({ label, meta, unit, cap }: { label: string; meta: DeliveryMeta; unit: "rows" | "chars"; cap?: number }) {
  const chars = meta.chars;
  const used = unit === "chars" ? (chars?.returned ?? 0) : meta.returned;
  const avail = unit === "chars" ? Math.max(chars?.available ?? 0, cap ?? 0) : meta.available;
  const pct = avail > 0 ? Math.min(100, Math.round((used / avail) * 100)) : 0;
  const tight = meta.truncated;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.82rem", marginBottom: "0.3rem" }}>
        <span>{label}</span>
        <span class="mono" style={{ fontSize: "0.72rem", color: tight ? "var(--warn)" : "var(--ink-faint)" }}>
          {used.toLocaleString()} / {avail.toLocaleString()} {unit}
          {tight ? " · full" : ""}
        </span>
      </div>
      <div class="lane-bar">
        <span style={{ width: `${pct}%`, background: tight ? "var(--warn)" : "var(--sage)" }} />
      </div>
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
  return <div class="mono" style={{ fontSize: "0.75rem", color: "var(--ink-faint)" }}>{children}</div>;
}
