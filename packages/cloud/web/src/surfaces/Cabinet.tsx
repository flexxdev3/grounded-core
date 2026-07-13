import { MOCK } from "../lib/fixtures.js";
import { IconArrow } from "../components/icons.js";

// Surface #6 — the existing @grounded/ui console, tenant-scoped, pointed at /api.
// It's a self-contained Preact SPA served by the same gateway; we mount it in a
// frame so its own shell (Recall · Facts · Sessions · Docs · Vision · Brief · Health)
// renders wholesale without being rebuilt here.
//
// Integration note: the console's client base must resolve to `/api` when served
// inside Cloud (it defaults to same-origin root). That's a one-line, config-driven
// change in @grounded/ui's api.ts — tracked with alicia. Until it lands we frame the
// served console; in the design/mock pass we render a faithful preview.
const CONSOLE_SRC = "./console/";

export function Cabinet() {
  if (MOCK) {
    return (
      <div class="view view-wide">
        <div class="view-head">
          <p class="eyebrow"><span class="p">&gt;_</span> cabinet</p>
          <h1 class="h1">The console, tenant-scoped.</h1>
          <p class="lede">Recall, facts, sessions, docs, vision, brief and health — the full Grounded console, mounted here against your cabinet.</p>
        </div>
        <div class="card scanned" style={{ minHeight: "50vh", display: "grid", placeItems: "center", textAlign: "center" }}>
          <div>
            <p class="eyebrow" style={{ justifyContent: "center", marginBottom: "1rem" }}><span class="p">&gt;_</span> @grounded/ui</p>
            <h3 class="h3">Console mounts here</h3>
            <p class="muted" style={{ maxWidth: "40ch", margin: "0.6rem auto 1.4rem" }}>
              The existing console renders in-place, pointed at your cabinet's <span class="mono" style={{ color: "var(--verdigris-bright)" }}>/api</span>. Reused wholesale — never rebuilt.
            </p>
            <a class="tlink" href="#/connect">connect an agent first <span class="arr"><IconArrow /></span></a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, top: "var(--topbar-h, 0)" }}>
      <iframe
        src={CONSOLE_SRC}
        title="Grounded console"
        style={{ width: "100%", height: "100%", border: 0, display: "block", background: "var(--night)" }}
      />
    </div>
  );
}
