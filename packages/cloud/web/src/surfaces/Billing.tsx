import { toast } from "../components/ui.js";
import { IconCheck } from "../components/icons.js";

// Surface #8 — stub. Plan comparison + Upgrade CTA to a placeholder. No Stripe this
// phase; the data model reserves it. Copy stays honest about what's live.
const PLANS = [
  {
    name: "Free",
    price: "$0",
    unit: "/ forever",
    current: true,
    cta: "Current plan",
    features: ["1 cabinet", "Unlimited facts & sessions", "Cited recall + brief", "Community support"],
  },
  {
    name: "Pro",
    price: "$12",
    unit: "/ month",
    current: false,
    featured: true,
    cta: "Upgrade to Pro",
    features: ["Everything in Free", "Priority embeddings", "Cabinet export & backups", "Email support"],
  },
  {
    name: "Team",
    price: "Let's talk",
    unit: "",
    current: false,
    cta: "Contact us",
    features: ["Shared cabinets", "SSO / SAML", "Dedicated shard", "SLA + onboarding"],
  },
];

export function Billing() {
  return (
    <div class="view view-wide">
      <div class="view-head">
        <p class="eyebrow"><span class="p">&gt;_</span> billing</p>
        <h1 class="h1">Plans</h1>
        <p class="lede">You're on Free — one cabinet, no ceremony. Paid plans arrive with the public launch.</p>
      </div>

      <div class="grid-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))" }}>
        {PLANS.map((p) => (
          <div
            class="card"
            key={p.name}
            style={p.featured ? { borderColor: "var(--line-strong)", boxShadow: "var(--shadow), var(--glow)" } : undefined}
          >
            <div class="row-between">
              <h3 class="h3">{p.name}</h3>
              {p.current && <span class="tag">current</span>}
              {p.featured && !p.current && <span class="tag tag-copper">popular</span>}
            </div>
            <div style={{ margin: "1rem 0 1.25rem", display: "flex", alignItems: "baseline", gap: "0.4rem" }}>
              <span class="display" style={{ fontSize: "clamp(2.2rem, 4vw, 2.8rem)" }}>{p.price}</span>
              <span class="mono dim">{p.unit}</span>
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 1.5rem", display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {p.features.map((f) => (
                <li key={f} class="row" style={{ gap: "0.55rem", alignItems: "flex-start" }}>
                  <span style={{ color: "var(--verdigris)", flexShrink: 0, marginTop: "0.15rem" }}><IconCheck /></span>
                  <span class="muted">{f}</span>
                </li>
              ))}
            </ul>
            <button
              class={`btn btn-block${p.current ? " btn-ghost" : p.featured ? "" : " btn-ghost"}`}
              disabled={p.current}
              onClick={() => toast(p.current ? "" : "Paid plans arrive at launch")}
            >
              {p.cta}
            </button>
          </div>
        ))}
      </div>

      <p class="mono dim" style={{ fontSize: "var(--fs-mono-sm)", marginTop: "1.5rem", textAlign: "center" }}>
        Billing is a preview — no card required, nothing to pay today.
      </p>
    </div>
  );
}
