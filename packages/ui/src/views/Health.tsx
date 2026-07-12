import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { HealthReport } from "@grounded/core/contract";
import { api } from "../api.js";
import { useAsync, useDataVersion } from "../hooks.js";

export function HealthView({ onAdapter }: { onAdapter: (a: string) => void }) {
  const version = useDataVersion();
  const { data, loading, error, reload } = useAsync<HealthReport>(() => api.health(), [version]);
  const [checkedAt, setCheckedAt] = useState("");

  useEffect(() => {
    if (data) {
      onAdapter(data.storage.adapter);
      setCheckedAt(new Date().toLocaleTimeString());
    }
  }, [data]);

  return (
    <div class="view-max">
      <div style={{ display: "flex", alignItems: "center", marginBottom: "1.2rem" }}>
        <div style={{ flex: 1 }}>
          <div class="eyebrow">&gt;_ health · is the cabinet live</div>
          <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: 0 }}>Health</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
          {checkedAt && (
            <span class="mono" style={{ fontSize: "0.66rem", color: "var(--paper-faint)" }}>
              checked {checkedAt}
            </span>
          )}
          <button class="btn btn-sm" onClick={reload}>Re-check</button>
        </div>
      </div>

      {loading && <div class="empty">Checking…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}

      {data && (
        <>
          <div class="card" style={{ display: "flex", alignItems: "center", gap: "0.7rem", marginBottom: "1.2rem" }}>
            <span class={`status-dot${data.ok ? "" : " down"}`} />
            <span class="h-serif" style={{ fontSize: "1.3rem" }}>{data.ok ? "All systems nominal" : "Degraded"}</span>
          </div>

          <div class="stat-grid">
            <Panel title="Storage" ok={data.storage.ok}>
              <Line k="adapter" v={data.storage.adapter} />
              {data.storage.location && <Line k="location" v={data.storage.location} />}
              {data.storage.detail && <Line k="detail" v={data.storage.detail} />}
            </Panel>
            <Panel title="Embeddings" ok={data.embeddings.ok}>
              <Line k="provider" v={data.embeddings.provider} />
              {data.embeddings.model && <Line k="model" v={data.embeddings.model} />}
              <Line k="dims" v={String(data.embeddings.dims)} />
              {data.embeddings.detail && <Line k="detail" v={data.embeddings.detail} />}
            </Panel>
            <Panel title="Counts" ok>
              <Line k="facts" v={String(data.counts.facts)} />
              <Line k="sessions" v={String(data.counts.sessions)} />
              <Line k="documents" v={String(data.counts.documents)} />
              <Line k="doc chunks" v={String(data.counts.docs)} />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function Panel({ title, ok, children }: { title: string; ok: boolean; children: ComponentChildren }) {
  return (
    <div class="card">
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.9rem" }}>
        <span class={`status-dot${ok ? "" : " down"}`} />
        <span class="stat-label" style={{ margin: 0 }}>{title}</span>
      </div>
      {children}
    </div>
  );
}
function Line({ k, v }: { k: string; v: string }) {
  return (
    <div class="mono" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.78rem", padding: "0.3rem 0", borderBottom: "1px solid var(--line)" }}>
      <span style={{ color: "rgba(236,230,216,0.45)" }}>{k}</span>
      <span style={{ color: "#ece6d8", textAlign: "right", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}
