import { useState } from "preact/hooks";
import { allInstallSnippets, INSTALL_TARGETS, type InstallTarget } from "@grounded/core/install";
import { useApp } from "../app.js";
import { copyText, fmtDate } from "../util.js";
import { toast } from "../hooks.js";

interface AgentRow {
  name: string;
  sessions: number;
  lastAt: string;
  projects: string[];
}

/** Group session rows by the agent that wrote them. Derived, never curated. */
export function groupByAgent(rows: { agent?: string | null; project?: string | null; createdAt: string }[]): AgentRow[] {
  const map = new Map<string, AgentRow>();
  for (const s of rows) {
    const name = s.agent?.trim() || "unattributed";
    const cur = map.get(name) ?? { name, sessions: 0, lastAt: "", projects: [] };
    cur.sessions += 1;
    if (s.createdAt > cur.lastAt) cur.lastAt = s.createdAt;
    const p = s.project?.trim();
    if (p && !cur.projects.includes(p)) cur.projects.push(p);
    map.set(name, cur);
  }
  return [...map.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

const SNIPPETS = allInstallSnippets();

/** Agents — who reads and writes this memory, and how to wire a new one. */
export function AgentsView() {
  const { review } = useApp();
  const [target, setTarget] = useState<InstallTarget>("claude-code");

  const agents = groupByAgent(review.sessions);
  const snip = SNIPPETS[target];

  return (
    <div class="view-max">
      <h1 class="h-serif display">Agents</h1>
      <p class="lede">Connect an agent once. After that it reads and writes memory without you.</p>

      <section aria-label="Connected agents" style={{ marginBottom: "1.8rem" }}>
        {agents.length === 0 && (
          <div class="empty">No agent has written here yet. Wire one below — its sessions will appear on their own.</div>
        )}
        {agents.map((a) => (
          <div key={a.name} class="row" style={{ cursor: "default" }}>
            <span class="type-tag session">agent</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div class="row-title" style={{ fontWeight: 500 }}>{a.name}</div>
              <div class="queue-sub">
                {a.sessions} {a.sessions === 1 ? "session" : "sessions"}
                {a.projects.length > 0 && ` · ${a.projects.slice(0, 3).join(", ")}${a.projects.length > 3 ? "…" : ""}`}
              </div>
            </div>
            <span class="row-meta">last {fmtDate(a.lastAt)}</span>
          </div>
        ))}
      </section>

      <section class="card" aria-label="Connect an agent" style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
        <div class="field-label" style={{ margin: 0 }}>Connect an agent</div>
        <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.5 }}>
          Paste this into your agent's MCP config. It talks to the Grounded service on this machine.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {INSTALL_TARGETS.map((t) => (
            <button key={t} class={`chip${target === t ? " active" : ""}`} onClick={() => setTarget(t)}>
              {SNIPPETS[t].label}
            </button>
          ))}
        </div>
        <div class="queue-sub mono">{snip.file}</div>
        <div class="term-wrap">
          <div class="term-head">
            <span class="mono">{snip.label}</span>
            <button
              class="btn btn-ghost btn-sm term-copy"
              onClick={async () => toast((await copyText(snip.snippet)) ? "Config copied" : "Copy failed")}
            >
              Copy
            </button>
          </div>
          <pre class="term-block" style={{ maxHeight: "14rem" }}>{snip.snippet}</pre>
        </div>
      </section>
    </div>
  );
}
