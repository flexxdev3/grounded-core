import { useState } from "preact/hooks";
import type { Vision, ListResult } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, useDataVersion, toast, bumpData } from "../hooks.js";
import { useApp } from "../app.js";
import { Modal } from "../components/Modal.js";
import { Markdown } from "../components/Markdown.js";

// Mirrors GroundedConfig.brief.reserve.vision's default (config.ts) and the
// chars÷4 approximation used everywhere else in the engine (no tokenizer).
// The server derives the same number from the DEPLOYMENT's configured reserve,
// so on a cabinet that has tuned brief.reserve.vision this counter is only an
// estimate — the 400 the server returns is the authority, and the save handler
// surfaces its message verbatim rather than second-guessing it.
const SUMMARY_RESERVE_TOK = 400;
const SUMMARY_RESERVE_CHARS = SUMMARY_RESERVE_TOK * 4;
// `details` is capped by the same reserve, and unlike `summary` going over is
// a REJECTED WRITE, not a soft budget. Counting it here means the operator
// sees the overage while typing instead of losing the edit to a 400 on save.
const DETAILS_CAP_CHARS = SUMMARY_RESERVE_CHARS;

/** One vision card: the single active record for a scope, edited in place. */
function VisionCard(props: {
  title: string;
  scope: string;
  active: Vision | null;
  emptyHint: string;
}) {
  const [editing, setEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [detailsDraft, setDetailsDraft] = useState("");

  const openEdit = () => {
    setSummaryDraft(props.active?.summary ?? "");
    setDetailsDraft(props.active?.details ?? "");
    setEditing(true);
  };

  const save = async () => {
    const details = detailsDraft.trim();
    if (!details) {
      toast("Vision details are required");
      return;
    }
    if (details.length > DETAILS_CAP_CHARS) {
      // Keep the modal open with the text intact — the operator has to cut
      // something, and losing the draft to a toast is the worst outcome.
      toast(
        `Details are ${details.length} chars, over the ${DETAILS_CAP_CHARS}-char cap. ` +
          `Trim ${details.length - DETAILS_CAP_CHARS}. History belongs in a session, not the vision.`,
      );
      return;
    }
    const summary = summaryDraft.trim();
    try {
      await api.vision.set({
        scope: props.scope,
        details,
        summary: summary || undefined,
        source: "console",
      });
      toast(props.active ? "Vision updated" : "Vision set");
      bumpData();
      setEditing(false);
    } catch (e) {
      toast(errMessage(e));
    }
  };

  const summaryLen = summaryDraft.trim().length;
  const overBudget = summaryLen > SUMMARY_RESERVE_CHARS;
  const detailsLen = detailsDraft.trim().length;
  const detailsOverCap = detailsLen > DETAILS_CAP_CHARS;

  return (
    <div class="card" style={{ marginBottom: "1.2rem" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: "0.8rem" }}>
        <div style={{ flex: 1 }}>
          <h2 class="h-serif" style={{ margin: 0, fontSize: "1.25rem" }}>{props.title}</h2>
          <span class="mono" style={{ fontSize: "0.68rem", color: "var(--paper-faint)" }}>
            {props.scope}
            {props.active ? ` · updated ${props.active.updatedAt.slice(0, 10)}` : ""}
          </span>
        </div>
        <button class="btn btn-ghost btn-sm" onClick={openEdit}>
          {props.active ? "Edit" : "Set vision"}
        </button>
      </div>

      {props.active ? (
        <>
          <div style={{ marginBottom: props.active.summary ? "1rem" : 0 }}>
            <div class="field-label" style={{ marginBottom: "0.4rem" }}>
              Summary · injected at every SessionStart
            </div>
            {props.active.summary ? (
              <div class="mono" style={{ fontSize: "0.8rem", color: "#ece6d8", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {props.active.summary}
              </div>
            ) : (
              <div class="mono" style={{ fontSize: "0.72rem", color: "var(--paper-faint)" }}>
                No summary set — the brief falls back to a truncated slice of the details below.
              </div>
            )}
          </div>
          <div>
            <div class="field-label" style={{ marginBottom: "0.4rem" }}>
              Details · recalled on demand, never injected
            </div>
            <Markdown source={props.active.details} />
          </div>
        </>
      ) : (
        <div class="empty">{props.emptyHint}</div>
      )}

      {editing && (
        <Modal
          title={props.active ? `Update ${props.title}` : `Set ${props.title}`}
          onClose={() => setEditing(false)}
          footer={
            <>
              <button class="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button class="btn btn-primary" onClick={save}>
                {props.active ? "Update vision" : "Set vision"}
              </button>
            </>
          }
        >
          <div style={{ marginBottom: "1rem" }}>
            <label class="field-label" style={{ display: "flex", alignItems: "center" }}>
              <span style={{ flex: 1 }}>Summary — terse bullets, injected into every SessionStart</span>
              <span class="mono" style={{ fontSize: "0.66rem", color: overBudget ? "var(--copper-bright)" : "var(--paper-faint)" }}>
                {summaryLen} / ~{SUMMARY_RESERVE_CHARS} chars ({SUMMARY_RESERVE_TOK} tok budget)
              </span>
            </label>
            <textarea
              class="textarea"
              style={{ minHeight: "5rem", fontFamily: "inherit" }}
              value={summaryDraft}
              placeholder={"- what this is\n- where it's going\n- what not to do"}
              onInput={(e) => setSummaryDraft((e.target as HTMLTextAreaElement).value)}
            />
            <p class="mono" style={{ fontSize: "0.66rem", color: "var(--paper-faint)", margin: "0.4rem 0 0" }}>
              Optional — blank falls back to a truncated slice of the details. Scarce and budgeted: keep it to bullets, not prose.
            </p>
          </div>
          <div>
            <label class="field-label" style={{ display: "flex", alignItems: "center" }}>
              <span style={{ flex: 1 }}>Details — narrative markdown, never recalled and never injected</span>
              <span class="mono" style={{ fontSize: "0.66rem", color: detailsOverCap ? "var(--copper-bright)" : "var(--paper-faint)" }}>
                {detailsLen} / {DETAILS_CAP_CHARS} chars{detailsOverCap ? " — over cap, save will fail" : ""}
              </span>
            </label>
            <textarea
              class="input"
              style={{ width: "100%", minHeight: "14rem", resize: "vertical", fontFamily: "inherit" }}
              value={detailsDraft}
              placeholder="Narrative markdown — what this is, where it's going, what not to do…"
              onInput={(e) => setDetailsDraft((e.target as HTMLTextAreaElement).value)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}

export function VisionView() {
  const { project } = useApp();
  const version = useDataVersion();
  const { data, loading, error } = useAsync<ListResult<Vision>>(
    () => api.vision.list({ limit: 200 }),
    [version],
  );

  const all = data?.data ?? [];
  const byScope = (scope: string) => ({
    active: all.find((v) => v.scope === scope) ?? null,
  });

  const global = byScope("global");
  const projScope = project ? `project:${project}` : null;
  const proj = projScope ? byScope(projScope) : null;

  return (
    <div class="view-max">
      <div style={{ marginBottom: "1.1rem" }}>
        <div class="eyebrow">&gt;_ vision · the direction</div>
        <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: 0 }}>Vision</h1>
        <p style={{ color: "var(--paper-faint)", margin: "0.4rem 0 0", fontSize: "0.85rem" }}>
          What the work is for. Injected into every brief — one active record per scope, edited in place.
        </p>
      </div>

      {loading && <div class="empty">Loading vision…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}

      {!loading && !error && (
        <>
          <VisionCard
            title="Global Vision"
            scope="global"
            active={global.active}
            emptyHint="No Global Vision yet. Write the one that tells every agent what all of this is for."
          />
          {proj && projScope ? (
            <VisionCard
              title="Project Vision"
              scope={projScope}
              active={proj.active}
              emptyHint={`No vision for ${project} yet. One paragraph: where this project is going and why it exists.`}
            />
          ) : (
            <div class="empty">Pick a project in the switcher to view or set its Project Vision.</div>
          )}
        </>
      )}
    </div>
  );
}
