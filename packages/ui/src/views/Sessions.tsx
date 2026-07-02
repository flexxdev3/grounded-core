import { useState } from "preact/hooks";
import type { Session, SessionInput } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, useDataVersion, toast, bumpData } from "../hooks.js";
import { useApp } from "../app.js";
import { Modal } from "../components/Modal.js";
import { IconPlus } from "../icons.js";
import { fmtDate } from "../util.js";

export function SessionsView() {
  const { openRecord } = useApp();
  const version = useDataVersion();
  const [adding, setAdding] = useState(false);
  const { data, loading, error } = useAsync<Session[]>(() => api.sessions.list({ limit: 200 }), [version]);

  const sessions = data ?? [];
  // group by day for the timeline
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const day = s.createdAt.slice(0, 10);
    (groups.get(day) ?? groups.set(day, []).get(day)!).push(s);
  }

  return (
    <div class="view-max">
      <div style={{ display: "flex", alignItems: "center", marginBottom: "1.4rem" }}>
        <div style={{ flex: 1 }}>
          <div class="eyebrow">&gt;_ sessions · what happened recently</div>
          <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: 0 }}>Sessions</h1>
        </div>
        <button class="btn btn-primary" onClick={() => setAdding(true)}>
          <IconPlus /> Log session
        </button>
      </div>

      {loading && <div class="empty">Loading sessions…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}
      {!loading && !error && sessions.length === 0 && (
        <div class="empty">No sessions logged yet.</div>
      )}

      {Array.from(groups.entries()).map(([day, rows]) => (
        <div key={day} style={{ display: "flex", gap: "1.1rem", marginBottom: "0.4rem" }}>
          <div style={{ flex: "none", width: "6rem", paddingTop: "0.9rem" }}>
            <div class="mono" style={{ fontSize: "0.7rem", color: "var(--verdigris)" }}>{day}</div>
          </div>
          <div style={{ flex: 1, minWidth: 0, borderLeft: "1px solid var(--line-2)", paddingLeft: "1.1rem" }}>
            {rows.map((s) => (
              <div key={s.id} class="row" style={{ display: "block" }} onClick={() => openRecord(`session:${s.id}`)}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <span class="row-title" style={{ fontWeight: 500 }}>{s.summary}</span>
                  <span class="row-meta">{fmtDate(s.createdAt).slice(11)}</span>
                </div>
                <div class="mono" style={{ fontSize: "0.66rem", color: "rgba(236,230,216,0.4)", marginTop: "0.35rem" }}>
                  {[s.project, s.agent, s.machine].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {adding && <SessionModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function SessionModal({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState("");
  const [project, setProject] = useState("");
  const [details, setDetails] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!summary.trim() || busy) return;
    setBusy(true);
    const input: SessionInput = { summary: summary.trim(), source: "manual" };
    if (project.trim()) input.project = project.trim();
    if (details.trim()) input.details = details.trim();
    const t = tags.split(",").map((x) => x.trim()).filter(Boolean);
    if (t.length) input.tags = t;
    try {
      await api.sessions.add(input);
      toast("Session logged");
      bumpData();
      onClose();
    } catch (err) {
      toast(errMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="Log session" onClose={onClose}>
      <form class="stack" style={{ gap: "0.9rem" }} onSubmit={submit}>
        <div>
          <label class="field-label">Summary</label>
          <input class="input" value={summary} placeholder="One line — what happened"
            onInput={(e) => setSummary((e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <label class="field-label">Project</label>
          <input class="input" value={project} placeholder="grounded"
            onInput={(e) => setProject((e.target as HTMLInputElement).value)} />
        </div>
        <div>
          <label class="field-label">Details</label>
          <textarea class="textarea" value={details}
            onInput={(e) => setDetails((e.target as HTMLTextAreaElement).value)} />
        </div>
        <div>
          <label class="field-label">Tags (comma-separated)</label>
          <input class="input" value={tags} placeholder="ui, phase6"
            onInput={(e) => setTags((e.target as HTMLInputElement).value)} />
        </div>
        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "0.4rem" }}>
          <button type="button" class="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
            {busy ? <span class="spinner" /> : "Log session"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
