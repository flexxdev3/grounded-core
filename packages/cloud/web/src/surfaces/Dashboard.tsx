import { useEffect, useState } from "preact/hooks";
import { account, errMessage } from "../lib/api.js";
import type { CabinetStatus } from "../lib/types.js";
import { cabinetBrief } from "../lib/brief.js";
import { BriefPanel, CopyButton } from "../components/ui.js";
import { IconArrow } from "../components/icons.js";
import type { Route } from "../app.js";

export function Dashboard({ onGo }: { onGo: (r: Route) => void }) {
  const [data, setData] = useState<CabinetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    account.cabinet().then(setData).catch((e) => setError(errMessage(e)));
  }, []);

  if (error) return <div class="view"><div class="notice notice-error">{error}</div></div>;
  if (!data) {
    return (
      <div class="center-note">
        <span class="spinner" />
        <span class="mono dim">loading cabinet…</span>
      </div>
    );
  }

  const { cabinet, endpoint, health } = data;
  const stats = [
    { n: health.counts.facts, u: "facts" },
    { n: health.counts.sessions, u: "sessions" },
    { n: health.counts.documents, u: "documents" },
    { n: health.embeddings.dims, u: "embed dims" },
  ];

  return (
    <div class="view view-wide">
      <div class="view-head">
        <p class="eyebrow"><span class="p">&gt;_</span> cabinet</p>
        <h1 class="h1">Your cabinet is online.</h1>
        <p class="lede">Everything your agents remember — cited, inspectable, yours.</p>
      </div>

      <div class="stat-grid" style={{ marginBottom: "1.5rem" }}>
        {stats.map((s) => (
          <div class="stat" key={s.u}>
            <div class="n">{s.n.toLocaleString()}</div>
            <div class="u">{s.u}</div>
          </div>
        ))}
      </div>

      <div class="grid-2" style={{ alignItems: "start" }}>
        <div class="card">
          <div class="row-between" style={{ marginBottom: "1.1rem" }}>
            <h3 class="h3">Endpoint</h3>
            <span class="tag">{cabinet.plan} plan</span>
          </div>
          <div class="row" style={{ gap: "0.6rem", marginBottom: "1.1rem" }}>
            <code class="input mono" style={{ display: "flex", alignItems: "center", overflowX: "auto", whiteSpace: "nowrap" }}>{endpoint}</code>
            <CopyButton value={endpoint} toastMsg="Endpoint copied" />
          </div>
          <div class="status-strip">
            <span><span class="status-dot" />online</span>
            <span class="sep">·</span>
            <span>region {cabinet.shard ?? "ovh-gra"}</span>
            <span class="sep">·</span>
            <span>{health.storage.adapter}</span>
            <span class="sep">·</span>
            <span>embed {health.embeddings.model}</span>
          </div>
          <div class="row mt-lg" style={{ gap: "0.7rem" }}>
            <button class="btn btn-sm" onClick={() => onGo("connect")}>Connect an agent <IconArrow /></button>
            <button class="btn btn-ghost btn-sm" onClick={() => onGo("cabinet")}>Open cabinet</button>
          </div>
        </div>

        <BriefPanel lines={cabinetBrief(health.counts)} title="what your agents wake up to" caret={false} />
      </div>
    </div>
  );
}
