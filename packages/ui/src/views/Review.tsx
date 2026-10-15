import { useState } from "preact/hooks";
import type { Fact, FactInput } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { bumpData, toast } from "../hooks.js";
import { useApp } from "../app.js";
import { Modal } from "../components/Modal.js";
import { FactForm } from "../components/FactForm.js";
import { SessionModal } from "../components/SessionModal.js";
import { keepItem, markReviewed, type ReviewLane } from "../lib/reviewState.js";
import { fmtDate } from "../util.js";
import { VisionView } from "./Vision.js";

const LANES: { key: ReviewLane; label: string }[] = [
  { key: "facts", label: "Facts" },
  { key: "sessions", label: "Sessions" },
  { key: "vision", label: "Vision" },
];

/** Review — what agents wrote since you last looked. It is already live:
 * keep it, fix it, or remove it. */
export function ReviewView() {
  const { navigate, openRecord, params, review } = useApp();
  const tabParam = params.get("tab");
  const tab: ReviewLane = tabParam === "sessions" || tabParam === "vision" ? tabParam : "facts";
  const [editing, setEditing] = useState<Fact | null>(null);
  const [logging, setLogging] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { project } = useApp();

  const keep = (lane: ReviewLane, id: number) => {
    keepItem(lane, id);
    bumpData();
  };
  const markAll = (lane: ReviewLane) => {
    markReviewed(lane);
    bumpData();
    toast("Marked reviewed");
  };

  const saveFact = async (f: Fact, input: FactInput) => {
    try {
      await api.facts.update(f.id, input);
      keepItem("facts", f.id);
      toast("Fact updated");
      bumpData();
      setEditing(null);
    } catch (e) {
      toast(errMessage(e));
    }
  };
  const pinFact = async (f: Fact) => {
    try {
      await api.facts.update(f.id, { pinned: !f.pinned });
      keepItem("facts", f.id);
      toast(f.pinned ? "Unpinned" : "Pinned — ranks above session lore");
      bumpData();
    } catch (e) {
      toast(errMessage(e));
    }
  };
  const deleteFact = async (f: Fact) => {
    if (!confirm(`Delete fact:${f.id}?\n\n“${f.fact}”`)) return;
    try {
      await api.facts.delete(f.id);
      toast("Fact deleted");
      bumpData();
    } catch (e) {
      toast(errMessage(e));
    }
  };

  const freshFacts = review.fresh.facts;
  const freshSessions = review.fresh.sessions;
  const sessions = showAll ? review.sessions : freshSessions;

  return (
    <div class="view-max">
      <h1 class="h-serif display">Review</h1>
      <p class="lede">
        What your agents wrote since you last looked here. It is already live — keep it, fix it, or
        remove it.
      </p>

      <div role="tablist" aria-label="Lane" class="tabs">
        {LANES.map((l) => {
          const n = review.fresh[l.key].length;
          return (
            <button
              key={l.key}
              role="tab"
              aria-selected={tab === l.key}
              class={`tab${tab === l.key ? " active" : ""}`}
              onClick={() => navigate("review", l.key === "facts" ? {} : { tab: l.key })}
            >
              {l.label}
              {n > 0 && <span class="tab-count">{n}</span>}
            </button>
          );
        })}
      </div>

      {review.loading && <div class="empty">Loading…</div>}
      {review.error && <div class="empty" style={{ color: "var(--danger)" }}>{review.error}</div>}

      {tab === "facts" && !review.loading && (
        <>
          {freshFacts.length === 0 && (
            <div class="empty">Nothing new. Every fact has been looked at.</div>
          )}
          {freshFacts.map((f) => (
            <article key={f.id} class="card review-card">
              <div class="review-head mono">
                <span>fact:{f.id} · {f.scope}</span>
                <span>{f.origin === "derived" ? "derived · " : ""}{fmtDate(f.createdAt)}</span>
              </div>
              <p class="review-body" onClick={() => openRecord(`fact:${f.id}`)}>{f.fact}</p>
              <div class="review-actions">
                <button class="btn btn-primary btn-sm" onClick={() => keep("facts", f.id)}>Keep</button>
                <button class="btn btn-sm" onClick={() => setEditing(f)}>Edit</button>
                <button class="btn btn-sm" onClick={() => pinFact(f)}>{f.pinned ? "Unpin" : "Pin"}</button>
                <span style={{ flex: 1 }} />
                <button class="btn btn-danger btn-sm" aria-label={`Delete fact ${f.id}`} onClick={() => deleteFact(f)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
          {freshFacts.length > 0 && (
            <div class="review-foot">
              <span class="queue-sub">{freshFacts.length} new of {review.facts.length} facts in scope</span>
              <button class="btn btn-sm" onClick={() => markAll("facts")}>Mark all reviewed</button>
            </div>
          )}
        </>
      )}

      {tab === "sessions" && !review.loading && (
        <>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.9rem" }}>
            <button class={`chip${!showAll ? " active" : ""}`} onClick={() => setShowAll(false)}>
              new · {freshSessions.length}
            </button>
            <button class={`chip${showAll ? " active" : ""}`} onClick={() => setShowAll(true)}>
              all · {review.sessions.length}
            </button>
            <span style={{ flex: 1 }} />
            <button class="btn btn-sm" onClick={() => setLogging(true)}>Log session</button>
          </div>
          {sessions.length === 0 && (
            <div class="empty">{showAll ? "No sessions logged yet." : "Nothing new since you last looked."}</div>
          )}
          {sessions.map((s) => (
            <div key={s.id} class="row" style={{ display: "block" }} onClick={() => openRecord(`session:${s.id}`)}>
              <div style={{ display: "flex", gap: "0.6rem" }}>
                <span class="row-meta" style={{ color: "var(--sage-deep)" }}>
                  {[s.project, s.agent, s.machine].filter(Boolean).join(" · ") || "—"}
                </span>
                <span class="row-meta" style={{ marginLeft: "auto" }}>{fmtDate(s.createdAt)}</span>
              </div>
              <div style={{ marginTop: "0.3rem", lineHeight: 1.45 }}>{s.summary}</div>
            </div>
          ))}
          {freshSessions.length > 0 && !showAll && (
            <div class="review-foot">
              <span />
              <button class="btn btn-sm" onClick={() => markAll("sessions")}>Mark all reviewed</button>
            </div>
          )}
        </>
      )}

      {tab === "vision" && !review.loading && (
        <>
          {review.fresh.vision.length > 0 && (
            <div class="review-foot" style={{ marginBottom: "1rem", borderTop: 0, paddingTop: 0 }}>
              <span class="queue-sub">
                {review.fresh.vision.length} vision {review.fresh.vision.length === 1 ? "entry" : "entries"} changed since you last looked
              </span>
              <button class="btn btn-sm" onClick={() => markAll("vision")}>Mark reviewed</button>
            </div>
          )}
          <VisionView />
        </>
      )}

      {editing && (
        <Modal title={`Edit fact:${editing.id}`} onClose={() => setEditing(null)}>
          <FactForm
            initial={editing}
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSubmit={(input) => saveFact(editing, input)}
          />
        </Modal>
      )}
      {logging && <SessionModal onClose={() => setLogging(false)} defaultProject={project ?? ""} />}
    </div>
  );
}
