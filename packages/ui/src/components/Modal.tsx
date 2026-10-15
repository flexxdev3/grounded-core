import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { IconClose } from "../icons.js";

const FOCUSABLE = 'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);

  // Escape closes; Tab stays inside the dialog.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="modal-scrim" onClick={props.onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={props.title} ref={box} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: "1.1rem" }}>
          <h3 class="h-serif" style={{ margin: 0, fontSize: "1.35rem", flex: 1 }}>
            {props.title}
          </h3>
          <button class="btn btn-ghost btn-sm" aria-label="Close" style={{ minHeight: 0, padding: "0.35rem" }} onClick={props.onClose}>
            <IconClose />
          </button>
        </div>
        {props.children}
        {props.footer && (
          <div style={{ display: "flex", gap: "0.6rem", marginTop: "1.3rem", justifyContent: "flex-end" }}>
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}
