import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { IconCheck, IconClose, IconCopy } from "./icons.js";

// ---- Toast channel (module event bus; one host renders it) ---------------
type Listener = (msg: string) => void;
const listeners = new Set<Listener>();
export function toast(msg: string): void {
  listeners.forEach((l) => l(msg));
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const l: Listener = (m) => {
      setMsg(m);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 2200);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      clearTimeout(timer);
    };
  }, []);
  if (!msg) return null;
  return <div class="toast">{msg}</div>;
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

// ---- Copy button ---------------------------------------------------------
export function CopyButton({ value, label = "Copy", toastMsg }: { value: string; label?: string; toastMsg?: string }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    const ok = await writeClipboard(value);
    if (ok) {
      setDone(true);
      if (toastMsg) toast(toastMsg);
      setTimeout(() => setDone(false), 1600);
    }
  };
  return (
    <button type="button" class={`copy-btn${done ? " copied" : ""}`} onClick={onClick} aria-label={label}>
      {done ? <IconCheck /> : <IconCopy />}
      {done ? "Copied" : label}
    </button>
  );
}

// ---- Terminal / code block with copy -------------------------------------
export function Term({ title, code, copy = true }: { title?: string; code: string; copy?: boolean }) {
  return (
    <div class="term scanned">
      <div class="term-bar">
        <span class="term-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {title && <span class="term-title">{title}</span>}
        {copy && (
          <span style={{ marginLeft: title ? "0.75rem" : "auto" }}>
            <CopyButton value={code} toastMsg="Copied to clipboard" />
          </span>
        )}
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---- The brief panel — THE signature -------------------------------------
export interface BriefLine {
  kind: "rule" | "head" | "kv" | "text" | "blank";
  key?: string;
  value?: string;
  text?: string;
}
export function BriefPanel({ lines, caret = true, title = "SessionStart · brief" }: { lines: BriefLine[]; caret?: boolean; title?: string }) {
  return (
    <div class="brief scanned">
      <div class="term-bar" style={{ borderBottom: "1px solid var(--line)" }}>
        <span class="prompt">&gt;_</span>
        <span class="term-title" style={{ marginLeft: "0.6rem" }}>{title}</span>
      </div>
      <div class="brief-body">
        {lines.map((l, i) => {
          if (l.kind === "blank") return <div key={i}>&nbsp;</div>;
          if (l.kind === "rule") return <div key={i} class="brief-rule">{l.text}</div>;
          if (l.kind === "head") return <div key={i} class="brief-h">{l.text}</div>;
          if (l.kind === "kv")
            return (
              <div key={i}>
                <span class="brief-key">{l.key}</span>
                <span class="brief-val"> {l.value}</span>
              </div>
            );
          return <div key={i} class="brief-cite">{l.text}</div>;
        })}
        {caret && (
          <div>
            <span class="prompt">&gt;_ </span>
            <span class="brief-caret" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Modal ---------------------------------------------------------------
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div class="overlay" onClick={onClose}>
      <div class="modal card scanned" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div class="modal-head">
          <h3 class="h3">{title}</h3>
          <button class="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
