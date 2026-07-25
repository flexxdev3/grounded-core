import { useState } from "preact/hooks";
import type { Doc, IngestReport } from "@grounded/core/contract";
import { api, errMessage } from "../api.js";
import { useAsync, useDataVersion, toast, bumpData } from "../hooks.js";
import { useApp } from "../app.js";
import { Modal } from "../components/Modal.js";
import { IconPlus } from "../icons.js";
import { fmtDate } from "../util.js";

const STATUS_COLOR: Record<Doc["status"], string> = {
  active: "var(--verdigris)",
  archived: "rgba(236,230,216,0.4)",
  missing: "var(--copper-bright)",
};

/** Derive a project/collection label from a doc path: the file's parent dir. */
function groupOf(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[parts.length - 2] : parts[0]) ?? "misc";
}
function fileOf(path: string): string {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface DocGroup {
  name: string;
  docs: Doc[];
  chunks: number;
}

export function DocsView() {
  const { openRecord, project } = useApp();
  const version = useDataVersion();
  const [ingesting, setIngesting] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // `documents: true` → one row per document (chunk 0), not every chunk.
  const { data, loading, error } = useAsync<Doc[]>(() => api.docs.list({ documents: true, limit: 2000 }), [version]);

  const docs = data ?? [];
  const q = filter.trim().toLowerCase();
  const matched = q
    ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q))
    : docs;

  const groups: DocGroup[] = Array.from(
    matched.reduce((m, d) => {
      const key = groupOf(d.path);
      const g = m.get(key) ?? { name: key, docs: [], chunks: 0 };
      g.docs.push(d);
      g.chunks += d.totalChunks;
      m.set(key, g);
      return m;
    }, new Map<string, DocGroup>()).values(),
  )
    .map((g) => ({ ...g, docs: g.docs.sort((a, b) => a.title.localeCompare(b.title)) }))
    // Current project pinned to the top; everything else alphabetical.
    .sort((a, b) => {
      const ap = project && a.name === project ? 0 : 1;
      const bp = project && b.name === project ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });

  // Auto-open: any group while filtering, and the current-project group by default.
  const isOpen = (name: string) => (q ? true : open.has(name) || (!!project && name === project && !closed.has(name)));
  const toggle = (name: string) => {
    if (isOpen(name)) {
      const nc = new Set(closed).add(name);
      const no = new Set(open);
      no.delete(name);
      setClosed(nc);
      setOpen(no);
    } else {
      const no = new Set(open).add(name);
      const nc = new Set(closed);
      nc.delete(name);
      setOpen(no);
      setClosed(nc);
    }
  };

  return (
    <div class="view-max">
      <div style={{ display: "flex", alignItems: "center", marginBottom: "1.1rem" }}>
        <div style={{ flex: 1 }}>
          <div class="eyebrow">&gt;_ docs · indexed source of record</div>
          <h1 class="h-serif" style={{ fontSize: "1.7rem", margin: 0 }}>Docs</h1>
        </div>
        <button class="btn btn-primary" onClick={() => setIngesting(true)}>
          <IconPlus /> Ingest
        </button>
      </div>

      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginBottom: "1.2rem" }}>
        <input class="input" value={filter} placeholder="filter documents…"
          style={{ flex: 1 }}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <span class="mono" style={{ fontSize: "0.7rem", color: "rgba(236,230,216,0.4)", whiteSpace: "nowrap" }}>
          {groups.length} project{groups.length === 1 ? "" : "s"} · {matched.length} docs
        </span>
      </div>

      {loading && <div class="empty">Loading docs…</div>}
      {error && <div class="empty" style={{ color: "var(--copper-bright)" }}>{error}</div>}
      {!loading && !error && groups.length === 0 && (
        <div class="empty">{docs.length === 0 ? "No docs indexed. Ingest a folder to get started." : "No documents match that filter."}</div>
      )}

      {groups.map((g) => (
        <div key={g.name} style={{ marginBottom: "0.5rem" }}>
          <button class="doc-group-head" onClick={() => toggle(g.name)}>
            <span class="mono" style={{ color: "var(--verdigris)", width: "0.9rem", display: "inline-block" }}>
              {isOpen(g.name) ? "▾" : "▸"}
            </span>
            <span style={{ fontWeight: 600 }}>{g.name}</span>
            <span class="row-meta" style={{ marginLeft: "auto" }}>{g.docs.length} docs · {g.chunks} chunks</span>
          </button>
          {isOpen(g.name) && g.docs.map((d) => (
            <div key={d.id} class="row" style={{ marginLeft: "0.9rem" }} onClick={() => openRecord(`doc:${d.id}`)}>
              <span class="type-tag doc">doc</span>
              <div class="row-title" style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                <span>{d.title || fileOf(d.path)}</span>
                <span class="mono" style={{ fontSize: "0.66rem", color: "rgba(236,230,216,0.4)" }}>{fileOf(d.path)}</span>
              </div>
              {d.scope !== "global" && (
                <span class="chip" style={{ cursor: "default" }}>{d.scope}</span>
              )}
              <span class="row-meta" style={{ color: STATUS_COLOR[d.status] }}>{d.status}</span>
              <span class="row-meta">{d.totalChunks > 1 ? `${d.totalChunks} chunks` : fmtDate(d.ingestedAt).slice(0, 10)}</span>
            </div>
          ))}
        </div>
      ))}

      {ingesting && <IngestModal onClose={() => setIngesting(false)} />}
    </div>
  );
}

function IngestModal({ onClose }: { onClose: () => void }) {
  const [paths, setPaths] = useState("");
  const [src, setSrc] = useState("");
  const [scope, setScope] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<IngestReport | null>(null);

  const run = async (e: Event) => {
    e.preventDefault();
    const list = paths.split("\n").map((p) => p.trim()).filter(Boolean);
    if (!list.length || busy) return;
    setBusy(true);
    try {
      const rep = await api.docs.ingest(list, { source: src.trim() || undefined, scope: scope.trim() || undefined, dryRun });
      setReport(rep);
      toast(dryRun ? "Dry run complete" : `Ingested — +${rep.added} ~${rep.updated} ↻${rep.retagged}`);
      if (!dryRun) bumpData();
    } catch (err) {
      toast(errMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Ingest docs" onClose={onClose}>
      <form class="stack" style={{ gap: "0.9rem" }} onSubmit={run}>
        <div>
          <label class="field-label">Paths (one per line — files or folders on the server)</label>
          <textarea class="textarea mono" value={paths} placeholder={"/home/me/notes\n/home/me/docs/spec.md"}
            style={{ fontSize: "0.8rem" }}
            onInput={(e) => setPaths((e.target as HTMLTextAreaElement).value)} />
        </div>
        <div style={{ display: "flex", gap: "0.9rem" }}>
          <div style={{ flex: 1 }}>
            <label class="field-label">Source label (optional)</label>
            <input class="input" value={src} placeholder="repo:grounded"
              onInput={(e) => setSrc((e.target as HTMLInputElement).value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label class="field-label">Scope (optional)</label>
            <input class="input" value={scope} placeholder="global"
              onInput={(e) => setScope((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun((e.target as HTMLInputElement).checked)} />
          <span class="mono" style={{ fontSize: "0.7rem", color: "rgba(236,230,216,0.7)" }}>Dry run — report changes, write nothing</span>
        </label>

        {report && (
          <div class="terminal" style={{ fontSize: "0.74rem" }}>
            scanned {report.scanned} · <span class="kw">+{report.added}</span> added · ~{report.updated} updated · ↻{report.retagged} retagged · {report.skipped} skipped · -{report.removed} removed
          </div>
        )}

        <div style={{ display: "flex", gap: "0.6rem", justifyContent: "flex-end", marginTop: "0.4rem" }}>
          <button type="button" class="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>
            {busy ? <span class="spinner" /> : dryRun ? "Preview" : "Ingest"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
