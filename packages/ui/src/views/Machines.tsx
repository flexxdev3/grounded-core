import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { useApp } from "../app.js";
import { EmbeddingsSetup } from "../components/EmbeddingsNotice.js";
import { DocsView } from "./Docs.js";

function isRemote(location?: string | null): boolean {
  if (!location) return false;
  return /^[a-z]+:\/\//.test(location) || /^[\w.-]+:\d+/.test(location);
}

function fmtBytes(n?: number): string {
  if (!n) return "—";
  if (n > 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n > 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Machines — where this PC's memory lives, and the engine's vitals. */
export function MachinesView() {
  const { health, reloadHealth } = useApp();
  const [setupOpen, setSetupOpen] = useState(false);

  const emb = health?.embeddings;
  const embeddingsOff = emb ? emb.dims === 0 : false;
  const remote = isRemote(health?.storage.location);

  return (
    <div class="view-max">
      <div style={{ display: "flex", alignItems: "center" }}>
        <h1 class="h-serif display" style={{ flex: 1 }}>Machines</h1>
        <button class="btn btn-sm" onClick={reloadHealth}>Re-check</button>
      </div>
      <p class="lede">Where this PC's memory lives.</p>

      {!health && <div class="empty">Checking…</div>}

      {health && (
        <>
          <div class="stat-grid" style={{ marginBottom: "1.4rem" }}>
            <Panel title="Memory" ok={health.storage.ok}>
              <Line k="kept on" v={remote ? "a server on your network" : "this PC"} />
              <Line k="engine" v={health.storage.adapter} />
              {health.storage.location && <Line k="location" v={health.storage.location} />}
              <Line k="size" v={fmtBytes(health.counts.bytes)} />
              {health.storage.detail && <Line k="detail" v={health.storage.detail} />}
            </Panel>
            <Panel
              title="Search by meaning"
              ok={!embeddingsOff && (emb?.ok ?? true)}
              action={
                embeddingsOff ? (
                  <button class="btn btn-primary btn-sm" onClick={() => setSetupOpen(true)}>Set up</button>
                ) : undefined
              }
            >
              {embeddingsOff ? (
                <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.85rem", lineHeight: 1.5 }}>
                  Off — search works by keywords only. Turn it on to find things by what they mean.
                </p>
              ) : (
                <>
                  <Line k="provider" v={emb!.provider} />
                  {emb!.model && <Line k="model" v={emb!.model} />}
                  {emb!.device && (
                    <Line k="runs on" v={emb!.device === "gpu" ? "GPU (graphics card)" : "CPU (processor), slower"} />
                  )}
                  {emb!.detail && <Line k="detail" v={emb!.detail} />}
                </>
              )}
            </Panel>
            <Panel title="Stored" ok>
              <Line k="facts" v={String(health.counts.facts)} />
              <Line k="sessions" v={String(health.counts.sessions)} />
              <Line k="documents" v={String(health.counts.documents)} />
            </Panel>
          </div>

          {health.budget && (
            <details class="card" style={{ marginBottom: "1.6rem", padding: "0.9rem 1.2rem" }}>
              <summary class="field-label" style={{ cursor: "pointer", margin: 0 }}>
                Brief budgets (advanced)
              </summary>
              <div style={{ marginTop: "0.8rem" }}>
                {(["vision", "facts", "sessions"] as const).map((lane) => {
                  const b = health.budget![lane];
                  if (!b) return null;
                  const over = b.conformance.overRowCap + b.conformance.overLaneCap + b.conformance.overBodyCap;
                  return (
                    <Line
                      key={lane}
                      k={lane}
                      v={`${b.reserveTok} tok reserve · ${b.rows} rows${over ? ` · ${over} over cap` : ""}`}
                    />
                  );
                })}
              </div>
            </details>
          )}
        </>
      )}

      <section aria-label="Documents">
        <div class="field-label" style={{ marginBottom: "0.8rem" }}>Documents</div>
        <DocsView />
      </section>

      {setupOpen && <EmbeddingsSetup onClose={() => setSetupOpen(false)} />}
    </div>
  );
}

function Panel({ title, ok, action, children }: { title: string; ok: boolean; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <div class="card">
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.9rem" }}>
        <span class={`status-dot${ok ? "" : " down"}`} />
        <span class="stat-label" style={{ margin: 0, flex: 1 }}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}
function Line({ k, v }: { k: string; v: string }) {
  return (
    <div class="mono" style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.78rem", padding: "0.3rem 0", borderBottom: "1px solid var(--line)" }}>
      <span style={{ color: "var(--ink-faint)" }}>{k}</span>
      <span style={{ color: "var(--ink)", textAlign: "right", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}
