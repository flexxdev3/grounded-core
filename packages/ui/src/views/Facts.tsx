import { useState } from "preact/hooks";
import type { Fact, FactInput, ListOptions, ListResult } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, useDataVersion, toast, bumpData } from "../hooks.js";
import { useApp } from "../app.js";
import { ListRow } from "../components/ListRow.js";
import { Modal } from "../components/Modal.js";
import { FactForm } from "../components/FactForm.js";
import { IconPlus } from "../icons.js";

const FOCUS = "__focus";

const STATUS_COLOR: Record<Fact["status"], string> = {
  active: "var(--verdigris)",
  archived: "rgba(236,230,216,0.4)",
};

type StatusFilter = "active" | "archived" | "all";
const STATUS_FILTERS: StatusFilter[] = ["active", "archived", "all"];

export function FactsView() {
  const { openRecord, project } = useApp();
  const version = useDataVersion();
  const [adding, setAdding] = useState(false);
  // null = auto: focus the project (global + project scope) when one is active.
  const [scope, setScope] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const { data, loading, error } = useAsync<ListResult<Fact>>(
    () => api.facts.list({ limit: 500, status: statusFilter } satisfies ListOptions),
    [version, statusFilter],
  );

  const facts = data?.data ?? [];
  const effScope = scope ?? (project ? FOCUS : "all");
  const scopes = Array.from(new Set(facts.map((f) => f.scope))).sort();
  const query = q.trim().toLowerCase();

  const shown = facts.filter((f) => {
    const inScope =
      effScope === "all"
        ? true
        : effScope === FOCUS
          ? f.scope === "global" || f.scope === project
          : f.scope === effScope;
    if (!inScope) return false;
    if (!query) return true;
    return f.fact.toLowerCase().includes(query) || (f.detail ?? "").toLowerCase().includes(query);
  });
  // pinned first, then importance, then recency
  shown.sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) ||
    b.importance - a.importance ||
    b.updatedAt.localeCompare(a.updatedAt),
  );

  const addFact = async (input: FactInput) => {
    try {
      const added = await api.facts.add(input);
      toast(added.delivery.warning ?? "Fact added");
      bumpData();
      setAdding(false);
    } catch (e) {
      toast(errMessage(e));
    }
  };

  return (
    <div class="view-max">
      <div style={{ display: "flex", alignItems: "center", marginBottom: "1.1rem" }}>
        <div style={{ flex: 1 }}>
          <div class="eyebrow">&gt;_ facts · explicit memory</div>
          <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: 0 }}>Facts</h1>
        </div>
        <button class="btn btn-primary" onClick={() => setAdding(true)}>
          <IconPlus /> Add fact
        </button>
      </div>

      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginBottom: "0.9rem" }}>
        <input class="input" value={q} placeholder="search facts…" style={{ flex: 1 }}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <span class="mono" style={{ fontSize: "0.7rem", color: "var(--paper-faint)", whiteSpace: "nowrap" }}>
          {shown.length} of {facts.length}
        </span>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
        {project && (
          <button class={`chip${effScope === FOCUS ? " active" : ""}`} onClick={() => setScope(FOCUS)}>
            global + {project}
          </button>
        )}
        <button class={`chip${effScope === "all" ? " active" : ""}`} onClick={() => setScope("all")}>
          all
        </button>
        {scopes.map((s) => (
          <button key={s} class={`chip${effScope === s ? " active" : ""}`} onClick={() => setScope(s)}>
            {s}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
        {STATUS_FILTERS.map((s) => (
          <button key={s} class={`chip${statusFilter === s ? " active" : ""}`} onClick={() => setStatusFilter(s)}>
            {s}
          </button>
        ))}
      </div>

      {loading && <div class="empty">Loading facts…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}
      {!loading && !error && shown.length === 0 && (
        <div class="empty">
          {facts.length === 0
            ? "No facts yet. Agents write them as they work — or add the first rule yourself."
            : "No facts match this filter."}
        </div>
      )}
      {shown.map((f) => (
        <ListRow
          key={f.id}
          type="fact"
          title={f.fact}
          pinned={f.pinned}
          status={f.status}
          statusColor={STATUS_COLOR[f.status]}
          meta={`${f.scope}${f.importance ? ` · ${f.importance.toFixed(2)}` : ""}`}
          onClick={() => openRecord(`fact:${f.id}`)}
        />
      ))}

      {adding && (
        <Modal title="Add fact" onClose={() => setAdding(false)}>
          <FactForm submitLabel="Add fact" onCancel={() => setAdding(false)} onSubmit={addFact} />
        </Modal>
      )}
    </div>
  );
}
