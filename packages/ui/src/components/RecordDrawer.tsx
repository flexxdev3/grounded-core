import { useState, useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { TypedId, FullRecord, Fact, FactInput } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, toast, bumpData, useDataVersion } from "../hooks.js";
import { fmtDate } from "../util.js";
import { useApp, viewForType } from "../app.js";
import { IconClose } from "../icons.js";
import { Modal } from "./Modal.js";
import { FactForm } from "./FactForm.js";
import { Markdown } from "./Markdown.js";

const DRAWER_MIN = 360;
const DRAWER_KEY = "grounded.drawerWidth";

/** Clamp a pixel width to [min, 50% of viewport]. Max wins on tiny screens. */
function clampDrawer(px: number): number {
  const max = Math.round(window.innerWidth * 0.5);
  const min = Math.min(DRAWER_MIN, max);
  return Math.max(min, Math.min(px, max));
}

export function RecordDrawer(props: { typedId: TypedId; onClose: () => void }) {
  const { navigate } = useApp();
  const version = useDataVersion();
  const [editing, setEditing] = useState(false);
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(DRAWER_KEY));
    return clampDrawer(saved > 0 ? saved : Math.min(480, window.innerWidth * 0.92));
  });

  // keep the drawer within 50% if the window shrinks while open
  useEffect(() => {
    const onResize = () => setWidth((w) => clampDrawer(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => setWidth(clampDrawer(startW + (startX - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setWidth((w) => {
        localStorage.setItem(DRAWER_KEY, String(w));
        return w;
      });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const { data, loading, error } = useAsync<FullRecord>(
    () => api.get(props.typedId),
    [props.typedId, version],
  );

  const afterMutation = (msg: string) => {
    toast(msg);
    bumpData();
    props.onClose();
  };

  const updateFact = async (fact: Fact, patch: Partial<FactInput>) => {
    try {
      const updated = await api.facts.update(fact.id, patch);
      afterMutation(updated.delivery?.warning ?? "Fact updated");
    } catch (e) {
      toast(errMessage(e));
    }
  };

  const togglePin = async (fact: Fact) => {
    await updateFact(fact, { pinned: !fact.pinned });
  };

  const toggleArchive = async (fact: Fact) => {
    await updateFact(fact, { status: fact.status === "active" ? "archived" : "active" });
  };

  const del = async () => {
    if (!data || data.sourceType !== "fact") return;
    try {
      await api.facts.delete(data.record.id);
      afterMutation("Deleted");
    } catch (e) {
      toast(errMessage(e));
    }
  };

  return (
    <>
      <div class="drawer-scrim" onClick={props.onClose} />
      <aside class="drawer" style={{ width: `${width}px` }}>
        <div class="drawer-resize" onPointerDown={startResize} title="Drag to resize" />
        <div class="drawer-head">
          <span class={`type-tag ${data?.sourceType ?? ""}`}>{props.typedId.split(":")[0]}</span>
          <span class="mono" style={{ flex: 1, color: "rgba(236,230,216,0.5)", fontSize: "0.72rem" }}>
            {props.typedId}
          </span>
          <button class="btn btn-ghost btn-sm" style={{ minHeight: 0, padding: "0.35rem" }} onClick={props.onClose}>
            <IconClose />
          </button>
        </div>

        <div class="drawer-body">
          {loading && <div class="empty">Loading…</div>}
          {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}
          {data && <RecordBody rec={data} />}
        </div>

        {data && (
          <div class="drawer-foot">
            <button
              class="btn btn-ghost btn-sm"
              onClick={() => {
                navigate(viewForType(data.sourceType));
                props.onClose();
              }}
            >
              View in list
            </button>
            {data.sourceType === "fact" && (
              <>
                <button class="btn btn-sm" onClick={() => togglePin(data.record)}>
                  {data.record.pinned ? "Unpin" : "Pin"}
                </button>
                <button class="btn btn-sm" onClick={() => toggleArchive(data.record)}>
                  {data.record.status === "active" ? "Archive" : "Restore"}
                </button>
                <button class="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
                <button class="btn btn-danger btn-sm" onClick={del} style={{ marginLeft: "auto" }}>
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </aside>

      {editing && data?.sourceType === "fact" && (
        <Modal title="Edit fact" onClose={() => setEditing(false)}>
          <p class="mono" style={{ fontSize: "0.68rem", color: "rgba(236,230,216,0.5)", margin: "0 0 1rem" }}>
            Edits <span class="accent">fact:{data.record.id}</span> in place. Recall re-embeds when the text changes.
          </p>
          <FactForm
            initial={data.record}
            submitLabel="Save"
            onCancel={() => setEditing(false)}
            onSubmit={(input) => updateFact(data.record, input)}
          />
        </Modal>
      )}
    </>
  );
}

function Row(props: { label: string; children: ComponentChildren }) {
  return (
    <div style={{ marginBottom: "1.1rem" }}>
      <div class="field-label">{props.label}</div>
      <div style={{ color: "#ece6d8", fontSize: "0.92rem", lineHeight: 1.55 }}>{props.children}</div>
    </div>
  );
}

function RecordBody({ rec }: { rec: FullRecord }) {
  if (rec.sourceType === "fact") {
    const f = rec.record;
    return (
      <>
        <Row label="Fact">
          {f.pinned && <span class="pin-dot" style={{ marginRight: "0.4rem" }}>★</span>}
          {f.fact}
        </Row>
        {f.detail && <Row label="Detail"><Markdown source={f.detail} /></Row>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <Row label="Scope">{f.scope}</Row>
          <Row label="Category">{f.category || "—"}</Row>
          <Row label="Importance">{f.importance.toFixed(2)}</Row>
          <Row label="Status">{f.status}</Row>
        </div>
        {f.topicKey && <Row label="Topic key">{f.topicKey}</Row>}
        <Row label="Updated">{fmtDate(f.updatedAt)}</Row>
      </>
    );
  }
  if (rec.sourceType === "session") {
    const s = rec.record;
    return (
      <>
        <Row label="Summary">{s.summary}</Row>
        {s.details && <Row label="Details"><Markdown source={s.details} /></Row>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
          <Row label="Project">{s.project || "—"}</Row>
          <Row label="Agent">{s.agent || "—"}</Row>
          <Row label="Machine">{s.machine || "—"}</Row>
          <Row label="Logged">{fmtDate(s.createdAt)}</Row>
        </div>
        {s.tags && s.tags.length > 0 && (
          <Row label="Tags">
            <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
              {s.tags.map((t) => (
                <span key={t} class="chip" style={{ cursor: "default" }}>{t}</span>
              ))}
            </div>
          </Row>
        )}
      </>
    );
  }
  const d = rec.record;
  return (
    <>
      <Row label="Title">{d.title}</Row>
      <Row label="Path"><span class="mono" style={{ fontSize: "0.8rem" }}>{d.path}</span></Row>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
        <Row label="Source">{d.source}</Row>
        <Row label="Status">{d.status}</Row>
        <Row label="Chunk">{d.chunkIdx + 1} / {d.totalChunks}</Row>
        <Row label="Ingested">{fmtDate(d.ingestedAt)}</Row>
        <Row label="Scope">{d.scope}</Row>
      </div>
      <Row label="Body">
        <div style={{ maxHeight: "22rem", overflowY: "auto", paddingRight: "0.4rem" }}>
          <Markdown source={d.body} />
        </div>
      </Row>
    </>
  );
}
