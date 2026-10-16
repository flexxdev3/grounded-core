import { useEffect, useState } from "preact/hooks";
import type { BoxSchema, BoxStatus, QueryResult } from "@grounded/client";
import { api, errMessage } from "../api.js";
import { useApp } from "../app.js";
import { toast, useAsync } from "../hooks.js";
import { IconDatabox } from "../icons.js";
import { copyText, fmtDate } from "../util.js";

const STATE_COLOR: Record<BoxStatus["state"], string> = {
  fresh: "var(--ok)",
  stale: "var(--warn)",
  unindexed: "var(--warn)",
  empty: "var(--ink-faint)",
  error: "var(--danger)",
};

const STATE_TEXT: Record<BoxStatus["state"], string> = {
  fresh: "Up to date",
  stale: "Items changed — re-indexing",
  unindexed: "Not indexed yet — answers read the files directly",
  empty: "No items yet",
  error: "Index build failed",
};

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;

/** Databox — structured data your tools decoded once, queryable with SQL. */
export function DataboxView() {
  const { params, navigate } = useApp();
  const list = useAsync(() => api.databox.list(), []);
  const boxes = list.data?.data ?? [];
  const selected = params.get("box") ?? boxes[0]?.name ?? null;
  const box = boxes.find((b) => b.name === selected) ?? null;

  return (
    <div class="view-max">
      <h1 class="h-serif display">
        Databox <span class="preview-pill">Preview</span>
      </h1>
      <p class="lede">
        Structured data your tools decoded once — catalogues, inventories, extracts — answered by SQL in milliseconds
        instead of re-reading the raw files.
      </p>

      {list.loading && !list.data && <div class="empty"><span class="spinner" /></div>}
      {list.error && <div class="empty" style={{ color: "var(--danger)" }}>{list.error}</div>}
      {list.data && !list.data.meta.enabled && <Off />}
      {list.data?.meta.enabled && list.data.meta.runtime && !list.data.meta.runtime.ok && (
        <div class="card" style={{ borderColor: "var(--warn)", marginBottom: "1rem" }}>
          <b>DuckDB is not installed.</b> Databox is on but cannot answer queries ({list.data.meta.runtime.detail}). Run{" "}
          <span class="mono">grounded addon add databox</span>.
        </div>
      )}
      {list.data?.meta.enabled && boxes.length === 0 && (
        <div class="empty">
          Databox is on, but no box is configured. Add a <span class="mono">[[databox.box]]</span> to config.toml.
        </div>
      )}

      {boxes.length > 1 && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {boxes.map((b) => (
            <button
              key={b.name}
              class={`chip${b.name === selected ? " active" : ""}`}
              onClick={() => navigate("databox", { box: b.name })}
            >
              {b.name}
            </button>
          ))}
        </div>
      )}

      {box && <Box key={box.name} box={box} onChanged={list.reload} />}
    </div>
  );
}

function Off() {
  return (
    <div class="card" style={{ display: "flex", gap: "1rem", alignItems: "flex-start" }}>
      <span style={{ color: "var(--sage)", marginTop: "0.1rem" }}>
        <IconDatabox size="1.6rem" />
      </span>
      <div style={{ lineHeight: 1.55, minWidth: 0 }}>
        <div style={{ fontWeight: 500, marginBottom: "0.3rem" }}>Databox is off</div>
        <div style={{ color: "var(--ink-soft)", marginBottom: "0.7rem" }}>
          Point Grounded at a folder of JSON items an extractor wrote. It builds an index, gives your agents a schema
          card in search, and answers their SQL directly. Rows never enter memory.
        </div>
        <pre class="md-pre">
          <code>
            {[
              "grounded addon add databox --box cars=C:/data/cars",
              "",
              "# or by hand, in config.toml, then restart:",
              "[databox]",
              "enabled = true",
              "[[databox.box]]",
              'name = "cars"',
              'root = "C:/data/cars"   # holds items/*.json',
            ].join("\n")}
          </code>
        </pre>
      </div>
    </div>
  );
}

function Box({ box, onChanged }: { box: BoxStatus; onChanged: () => void }) {
  const schema = useAsync<BoxSchema | null>(
    () => (box.state === "empty" ? Promise.resolve(null) : api.databox.schema(box.name)),
    [box.name, box.index?.id],
  );
  const [indexing, setIndexing] = useState(false);

  // a box that is building, or stale (a build is starting), is polled until it settles.
  useEffect(() => {
    if (!box.building && box.state !== "stale") return;
    const t = setTimeout(onChanged, 1500);
    return () => clearTimeout(t);
  }, [box.building, box.state, box.index?.id]);

  const reindex = async () => {
    setIndexing(true);
    try {
      await api.databox.index(box.name, { force: true, wait: true });
      toast("Index rebuilt");
    } catch (e) {
      toast(errMessage(e));
    } finally {
      setIndexing(false);
      onChanged();
    }
  };

  return (
    <>
      <div class="card" style={{ marginBottom: "1.2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <span class="h-serif" style={{ fontSize: "1.25rem", fontWeight: 600 }}>{box.name}</span>
          <span class="mono" style={{ fontSize: "0.7rem", color: STATE_COLOR[box.state] }}>
            ● {box.building ? "Indexing…" : STATE_TEXT[box.state]}
          </span>
          <button
            class="btn btn-ghost btn-sm"
            style={{ marginLeft: "auto" }}
            disabled={indexing || box.building || box.state === "empty"}
            onClick={reindex}
          >
            {indexing ? <span class="spinner" /> : "Re-index"}
          </button>
        </div>
        {box.description && <div style={{ color: "var(--ink-soft)", marginTop: "0.35rem" }}>{box.description}</div>}
        <div class="mono" style={{ fontSize: "0.7rem", color: "var(--ink-faint)", marginTop: "0.6rem", lineHeight: 1.7, overflowWrap: "anywhere" }}>
          {box.items.files.toLocaleString()} items · {fmtBytes(box.items.bytes)}
          {box.index &&
            ` · ${box.index.tables} tables · ${box.index.rows.toLocaleString()} rows · indexed ${fmtDate(box.index.builtAt)} in ${box.index.buildMs} ms` +
              (box.index.build?.mode === "incremental"
                ? ` (incremental: ${box.index.build.changed} changed, ${box.index.build.removed} removed)`
                : box.index.build
                  ? ` (full: ${box.index.build.reason})`
                  : "")}
          <br />
          {box.root}
          {box.manifest && (
            <>
              <br />
              {Object.entries(box.manifest).map(([k, v]) => `${k}=${v}`).join(" · ")}
            </>
          )}
        </div>
        {box.lastError && (
          <div class="mono" style={{ fontSize: "0.72rem", color: "var(--danger)", marginTop: "0.6rem" }}>
            Last build failed {fmtDate(box.lastError.at)}: {box.lastError.message}
          </div>
        )}
      </div>

      {box.state !== "empty" && <Query box={box.name} schema={schema.data} />}
    </>
  );
}

function Query({ box, schema }: { box: string; schema: BoxSchema | null }) {
  const first = schema?.tables[0]?.name;
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sql && first) setSql(`select * from ${first} limit 20`);
  }, [first]);

  const run = async (text = sql) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.databox.query(box, text, { limit: 500 }));
    } catch (e) {
      setError(errMessage(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const pickTable = (name: string) => {
    const q = `select * from ${name} limit 20`;
    setSql(q);
    void run(q);
  };

  return (
    <>
      <label class="field-label">Query (read-only SQL, DuckDB) · Ctrl+Enter runs</label>
      <textarea
        class="textarea mono"
        style={{ fontSize: "0.82rem", minHeight: "5.5rem" }}
        value={sql}
        spellcheck={false}
        aria-label="SQL query"
        onInput={(e) => setSql((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run();
          }
        }}
      />
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", margin: "0.6rem 0 1rem", flexWrap: "wrap" }}>
        <button class="btn btn-primary btn-sm" disabled={busy} onClick={() => void run()}>
          {busy ? <span class="spinner" /> : "Run"}
        </button>
        {result && (
          <>
            <span class="mono" style={{ fontSize: "0.72rem", color: "var(--ink-faint)" }}>
              {result.meta.returned} of {result.meta.available.toLocaleString()}
              {result.meta.availableIsFloor ? "+" : ""} rows · {result.meta.elapsedMs} ms · {result.meta.source}
              {result.meta.stale && <span style={{ color: "var(--warn)" }}> · stale index</span>}
            </span>
            <button
              class="btn btn-ghost btn-sm"
              style={{ marginLeft: "auto" }}
              onClick={async () =>
                toast((await copyText(`${result.meta.citation}\n${result.meta.sql}`)) ? "Citation copied" : "Copy failed")
              }
            >
              Copy citation
            </button>
          </>
        )}
      </div>

      {error && (
        <div class="mono" style={{ color: "var(--danger)", fontSize: "0.78rem", marginBottom: "1rem", whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
      {result && <Rows result={result} />}

      {schema && (
        <section style={{ marginTop: "1.6rem" }}>
          <div class="field-label">Tables{schema.source === "json" ? " (read from the files; not indexed yet)" : ""}</div>
          {schema.tables.map((t) => (
            <div key={t.name} class="row" style={{ display: "block" }} onClick={() => pickTable(t.name)}>
              <div style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
                <span class="row-title mono" style={{ fontSize: "0.84rem" }}>{t.name}</span>
                {schema.source === "index" && <span class="row-meta">{t.rows.toLocaleString()} rows</span>}
              </div>
              <div
                class="mono"
                style={{ fontSize: "0.66rem", color: "var(--ink-faint)", marginTop: "0.3rem", lineHeight: 1.6, overflowWrap: "anywhere" }}
              >
                {t.columns.map((c) => `${c.name} ${c.type.length > 40 ? `${c.type.slice(0, 37)}…` : c.type}`).join(" · ")}
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Rows({ result }: { result: QueryResult }) {
  if (result.data.length === 0) return <div class="empty" style={{ padding: "1.2rem" }}>No rows.</div>;
  const cols = result.meta.columns.map((c) => c.name);
  const cell = (v: unknown) => (v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div class="dbx-grid">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.data.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const s = cell(row[c]);
                return (
                  <td key={c} title={s.length > 60 ? s : undefined} class={row[c] === null ? "null" : undefined}>
                    {s.length > 60 ? `${s.slice(0, 57)}…` : s}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
