import { useState } from "preact/hooks";
import { useApp } from "../app.js";
import { EmbeddingsSetup } from "../components/EmbeddingsNotice.js";
import { fmtDate } from "../util.js";

/** Home — is memory healthy? Everything here is derived: /health, timestamps,
 * recent sessions. Nothing on this screen is curated by hand. */
export function HomeView() {
  const { navigate, openRecord, health, project, review } = useApp();
  const [setupOpen, setSetupOpen] = useState(false);

  const ok = health?.ok ?? null;
  const embeddingsOff = health ? health.embeddings.dims === 0 : false;
  const needsYou = review.total > 0 || embeddingsOff;

  const headline =
    ok === null ? "Checking memory…" : ok ? "Memory is healthy." : "Memory needs attention.";
  const sub =
    ok === null
      ? "Reaching the service."
      : needsYou
        ? "Your agents are reading and writing on their own. " +
          (review.total > 0 && embeddingsOff
            ? "Two things need you."
            : "One thing needs you.")
        : "Your agents are reading and writing on their own. Nothing needs you.";

  const recent = review.sessions.slice(0, 3);

  return (
    <div class="view-max">
      <div class="hero" aria-hidden="true" />
      <div class="eyebrow">
        {health
          ? `${health.storage.adapter}${health.embeddings.provider !== "none" ? ` · ${health.embeddings.provider}` : ""}${project ? ` · ${project}` : ""}`
          : "console"}
      </div>
      <h1 class="h-serif display">{headline}</h1>
      <p class="lede">{sub}</p>

      <div class="stat-grid" style={{ marginBottom: "1.4rem" }}>
        <Tile label="Service" ok={ok !== false} value={ok === null ? "…" : ok ? "Running" : "Degraded"} />
        <Tile label="Storage" ok={health?.storage.ok ?? true} value={health?.storage.adapter ?? "…"} />
        <Tile
          label="Search by meaning"
          ok={!embeddingsOff && (health?.embeddings.ok ?? true)}
          value={
            !health
              ? "…"
              : embeddingsOff
                ? "Off"
                : `${health.embeddings.model ?? health.embeddings.provider}${health.embeddings.device ? ` · ${health.embeddings.device.toUpperCase()}` : ""}`
          }
        />
      </div>

      {(review.total > 0 || embeddingsOff) && (
        <section class="card" aria-label="Needs you" style={{ padding: 0, marginBottom: "1.4rem", overflow: "hidden" }}>
          <div class="field-label" style={{ padding: "0.9rem 1.2rem 0.2rem" }}>Needs you</div>
          {review.total > 0 && (
            <div class="queue-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>
                  {review.total} new {review.total === 1 ? "item" : "items"} from your agents
                </div>
                <div class="queue-sub">
                  {[
                    review.fresh.facts.length && `${review.fresh.facts.length} facts`,
                    review.fresh.sessions.length && `${review.fresh.sessions.length} sessions`,
                    review.fresh.vision.length && `${review.fresh.vision.length} vision`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  · since you last looked here
                </div>
              </div>
              <button class="btn btn-primary btn-sm" onClick={() => navigate("review")}>
                Review
              </button>
            </div>
          )}
          {embeddingsOff && (
            <div class="queue-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>Search by meaning is off</div>
                <div class="queue-sub">One-time setup — a small model downloads to your Grounded folder.</div>
              </div>
              <button class="btn btn-sm" onClick={() => setSetupOpen(true)}>
                Set up
              </button>
            </div>
          )}
        </section>
      )}

      <section aria-label="Recent sessions">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.6rem" }}>
          <div class="field-label" style={{ margin: 0 }}>Recent sessions</div>
          <button class="btn btn-ghost btn-sm" onClick={() => navigate("review", { tab: "sessions" })}>
            All {health?.counts.sessions ?? ""}
          </button>
        </div>
        {recent.length === 0 && <div class="empty">No sessions yet. Agents log them as they finish work.</div>}
        {recent.map((s) => (
          <div key={s.id} class="row" style={{ display: "block" }} onClick={() => openRecord(`session:${s.id}`)}>
            <div style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
              <span class="row-meta" style={{ color: "var(--sage-deep)" }}>
                {[s.project, s.machine].filter(Boolean).join(" · ") || "—"}
              </span>
              <span class="row-meta" style={{ marginLeft: "auto" }}>{fmtDate(s.createdAt)}</span>
            </div>
            <div style={{ marginTop: "0.3rem", lineHeight: 1.45 }}>{s.summary}</div>
          </div>
        ))}
      </section>

      {health && (
        <div class="home-foot mono">
          <button onClick={() => navigate("review")}>{health.counts.facts} facts</button>
          <button onClick={() => navigate("review", { tab: "sessions" })}>{health.counts.sessions} sessions</button>
          <button onClick={() => navigate("search")}>{health.counts.documents} docs</button>
        </div>
      )}

      {setupOpen && <EmbeddingsSetup onClose={() => setSetupOpen(false)} />}
    </div>
  );
}

function Tile({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div class="card" style={{ padding: "0.85rem 1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
        <span class={`status-dot${ok ? "" : " down"}`} />
        <span class="stat-label" style={{ margin: 0 }}>{label}</span>
      </div>
      <div style={{ fontWeight: 500, marginTop: "0.35rem" }}>{value}</div>
    </div>
  );
}
