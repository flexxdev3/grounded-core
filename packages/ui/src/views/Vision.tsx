import { useState } from "preact/hooks";
import type { Vision } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, useDataVersion, toast, bumpData } from "../hooks.js";
import { useApp } from "../app.js";
import { Modal } from "../components/Modal.js";
import { Markdown } from "../components/Markdown.js";

/** One vision card: active record + edit-via-set + collapsible history. */
function VisionCard(props: {
  title: string;
  scope: string;
  active: Vision | null;
  history: Vision[];
  emptyHint: string;
}) {
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState("");

  const openEdit = () => {
    setDraft(props.active?.content ?? "");
    setEditing(true);
  };

  const save = async () => {
    const content = draft.trim();
    if (!content) {
      toast("Vision content is required");
      return;
    }
    try {
      await api.vision.set({ scope: props.scope, content, source: "console" });
      toast(props.active ? "Vision updated (prior version kept in history)" : "Vision set");
      bumpData();
      setEditing(false);
    } catch (e) {
      toast(errMessage(e));
    }
  };

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
        <Markdown source={props.active.content} />
      ) : (
        <div class="empty">{props.emptyHint}</div>
      )}

      {props.history.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <button class="chip" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? "hide" : "show"} history ({props.history.length})
          </button>
          {showHistory &&
            props.history.map((v) => (
              <div
                key={v.id}
                style={{
                  marginTop: "0.8rem",
                  paddingLeft: "0.9rem",
                  borderLeft: "2px solid var(--line, rgba(127,127,127,0.25))",
                  opacity: 0.72,
                }}
              >
                <div class="mono" style={{ fontSize: "0.66rem", color: "var(--paper-faint)", marginBottom: "0.3rem" }}>
                  superseded · {v.updatedAt.slice(0, 10)}
                  {v.supersededBy ? ` · replaced by #${v.supersededBy}` : ""}
                </div>
                <Markdown source={v.content} />
              </div>
            ))}
        </div>
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
          <p class="mono" style={{ fontSize: "0.7rem", color: "var(--paper-faint)", marginTop: 0 }}>
            {props.active
              ? "Saving retires the current version into history and makes this the active vision."
              : "This becomes the active vision, injected into every brief for this scope."}
          </p>
          <textarea
            class="input"
            style={{ width: "100%", minHeight: "14rem", resize: "vertical", fontFamily: "inherit" }}
            value={draft}
            placeholder="Narrative markdown — what this is, where it's going, what not to do…"
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
          />
        </Modal>
      )}
    </div>
  );
}

export function VisionView() {
  const { project } = useApp();
  const version = useDataVersion();
  const { data, loading, error } = useAsync<Vision[]>(
    () => api.vision.list({ status: "all", limit: 200 }),
    [version],
  );

  const all = data ?? [];
  const byScope = (scope: string) => ({
    active: all.find((v) => v.scope === scope && v.status === "active") ?? null,
    history: all
      .filter((v) => v.scope === scope && v.status !== "active")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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
          What the work is for. Injected into every brief — one active record per scope, history kept.
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
            history={global.history}
            emptyHint="No Global Vision yet. Write the one that tells every agent what all of this is for."
          />
          {proj && projScope ? (
            <VisionCard
              title="Project Vision"
              scope={projScope}
              active={proj.active}
              history={proj.history}
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
