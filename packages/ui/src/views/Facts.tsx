import { useState } from "preact/hooks";
import type { Fact, FactInput } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, useDataVersion, toast, bumpData } from "../hooks.js";
import { useApp } from "../app.js";
import { ListRow } from "../components/ListRow.js";
import { Modal } from "../components/Modal.js";
import { FactForm } from "../components/FactForm.js";
import { IconPlus } from "../icons.js";

export function FactsView() {
  const { openRecord } = useApp();
  const version = useDataVersion();
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState<string>("all");
  const { data, loading, error } = useAsync<Fact[]>(() => api.facts.list({ limit: 500 }), [version]);

  const facts = data ?? [];
  const scopes = ["all", ...Array.from(new Set(facts.map((f) => f.scope))).sort()];
  const shown = scope === "all" ? facts : facts.filter((f) => f.scope === scope);
  // pinned first, then importance, then recency
  shown.sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) ||
    b.importance - a.importance ||
    b.updatedAt.localeCompare(a.updatedAt),
  );

  const addFact = async (input: FactInput) => {
    try {
      await api.facts.add(input);
      toast("Fact added");
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

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
        {scopes.map((s) => (
          <button key={s} class={`chip${scope === s ? " active" : ""}`} onClick={() => setScope(s)}>
            {s}
          </button>
        ))}
      </div>

      {loading && <div class="empty">Loading facts…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}
      {!loading && !error && shown.length === 0 && (
        <div class="empty">No facts yet. Add the first hard rule.</div>
      )}
      {shown.map((f) => (
        <ListRow
          key={f.id}
          type="fact"
          title={f.fact}
          pinned={f.pinned}
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
