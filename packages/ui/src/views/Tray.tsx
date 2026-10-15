import { useState } from "preact/hooks";
import { useApp } from "../app.js";
import { IconLogo } from "../icons.js";
import { fmtDate } from "../util.js";

/** Open the full console. A Tauri shell injects __GROUNDED_OPEN_MAIN__ to
 * open its main window; in a plain browser we navigate this window. */
function openMain(hash: string, navigate: (v: never) => void): void {
  const hook = (window as unknown as { __GROUNDED_OPEN_MAIN__?: (h: string) => void }).__GROUNDED_OPEN_MAIN__;
  if (hook) {
    hook(hash);
    return;
  }
  location.hash = hash;
  void navigate;
}

/** Tray flyout — the small surface next to the clock. ~340px, no shell. */
export function TrayView() {
  const { health, review } = useApp();
  const [q, setQ] = useState("");

  const online = health ? health.ok : null;
  const recent = review.sessions.slice(0, 3);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!q.trim()) return;
    openMain(`#/search?q=${encodeURIComponent(q.trim())}`, () => {});
  };

  return (
    <div class="tray">
      <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
        <span class="brand-mark" aria-hidden="true" style={{ color: "var(--sage)" }}>
          <IconLogo />
        </span>
        <div style={{ flex: 1, lineHeight: 1.2 }}>
          <div class="brand-name" style={{ fontSize: "1.15rem" }}>Grounded</div>
          <div class="status-line" style={{ marginTop: "0.15rem" }}>
            <span class={`status-dot${online === false ? " down" : ""}`} />
            {online === null ? "connecting…" : online ? "memory is healthy" : "needs attention"}
          </div>
        </div>
      </div>

      <form class="searchbox" onSubmit={submit}>
        <span class="prompt" aria-hidden="true">⌕</span>
        <input
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Search memory"
          aria-label="Search memory"
        />
      </form>

      {review.total > 0 && (
        <button class="tray-cta" onClick={() => openMain("#/review", () => {})}>
          <span style={{ flex: 1, textAlign: "left", fontWeight: 500 }}>
            {review.total} new {review.total === 1 ? "item" : "items"} to review
          </span>
          <span aria-hidden="true">→</span>
        </button>
      )}

      <section aria-label="Recent activity" style={{ flex: 1, minHeight: 0 }}>
        <div class="field-label">Recent activity</div>
        {recent.length === 0 && <div class="queue-sub">Nothing yet.</div>}
        {recent.map((s) => (
          <div key={s.id} style={{ display: "flex", gap: "0.6rem", fontSize: "0.82rem", padding: "0.3rem 0" }}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.summary}
            </span>
            <span class="row-meta">{fmtDate(s.createdAt).slice(5, 10)}</span>
          </div>
        ))}
      </section>

      <button class="btn btn-primary" style={{ justifyContent: "center" }} onClick={() => openMain("#/home", () => {})}>
        Open Grounded
      </button>
    </div>
  );
}
