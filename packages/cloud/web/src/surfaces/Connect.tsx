import { useEffect, useState } from "preact/hooks";
import { account, errMessage } from "../lib/api.js";
import type { ConnectPayload } from "../lib/types.js";
import { CopyButton, Term } from "../components/ui.js";

const TABS: { key: keyof ConnectPayload["snippets"]; label: string; title: string }[] = [
  { key: "hook", label: "SessionStart hook", title: "~/.claude · settings hook" },
  { key: "curl", label: "curl", title: "shell" },
  { key: "client", label: "@grounded/client", title: "your-agent.ts" },
];

export function Connect() {
  const [data, setData] = useState<ConnectPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<keyof ConnectPayload["snippets"]>("hook");

  useEffect(() => {
    account.connect().then(setData).catch((e) => setError(errMessage(e)));
  }, []);

  if (error) return <div class="view"><div class="notice notice-error">{error}</div></div>;
  if (!data) {
    return (
      <div class="center-note">
        <span class="spinner" />
        <span class="mono dim">loading connect config…</span>
      </div>
    );
  }

  const active = TABS.find((t) => t.key === tab)!;

  return (
    <div class="view">
      <div class="view-head">
        <p class="eyebrow"><span class="p">&gt;_</span> connect your agent</p>
        <h1 class="h1">One line between self-hosted and hosted.</h1>
        <p class="lede">Point any agent at your cabinet. Same API a self-hoster runs — only the URL and token differ.</p>
      </div>

      <div class="field" style={{ marginBottom: "1.5rem" }}>
        <span class="field-label">Endpoint</span>
        <div class="row" style={{ gap: "0.6rem" }}>
          <code class="input mono" style={{ display: "flex", alignItems: "center", overflowX: "auto", whiteSpace: "nowrap" }}>{data.endpoint}</code>
          <CopyButton value={data.endpoint} toastMsg="Endpoint copied" />
        </div>
      </div>

      <div class="tabs" style={{ marginBottom: "1rem" }} role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} class={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <Term title={active.title} code={data.snippets[tab]} />

      <div class="notice notice-warn mt-md">
        <span>
          Replace <code class="mono" style={{ color: "var(--copper-bright)" }}>grnd_&lt;your-token&gt;</code> with a real token
          — create one under <b style={{ color: "var(--verdigris-bright)" }}>API tokens</b>. The secret is shown once at creation.
        </span>
      </div>
    </div>
  );
}
